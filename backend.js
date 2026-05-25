import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { Queue, Worker, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import cors from 'cors';
import ws from 'ws';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';

dotenv.config();

// ================= ENV VALIDATION =================

const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'REDIS_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'CRON_SECRET',
  'BACKEND_URL',
];

const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

// ================= LOGGER =================

const log = {
  info:  (...args) => console.log(`[${new Date().toISOString()}] INFO `, ...args),
  warn:  (...args) => console.warn(`[${new Date().toISOString()}] WARN `, ...args),
  error: (...args) => console.error(`[${new Date().toISOString()}] ERROR`, ...args),
};

// ================= CONFIG =================

const LEETCODE_API  = 'https://leetcode-api-vercel.vercel.app';
const FRONTEND_URL  = process.env.FRONTEND_URL || 'http://localhost:5173';
const PORT          = parseInt(process.env.PORT || '3001', 10);
const NODE_ENV      = process.env.NODE_ENV || 'development';
const IS_PROD       = NODE_ENV === 'production';

// ================= CLIENTS =================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { realtime: { transport: ws } }
);

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck:     false,
  lazyConnect:          false,
  retryStrategy:        (times) => Math.min(times * 50, 2000), // Exponential backoff
  reconnectOnError:     (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) return true;
    return false;
  },
});

redis.on('error', (err) => log.error('Redis connection error:', err.message));
redis.on('connect', ()  => log.info('Redis connected'));

// ================= QUEUE =================

const emailQueue = new Queue('emails', {
  connection: redis,
  defaultJobOptions: {
    attempts:        5,
    backoff:         { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 500 },
  },
});

const queueEvents = new QueueEvents('emails', { connection: redis });
queueEvents.on('failed', ({ jobId, failedReason }) => {
  log.error(`Job ${jobId} failed: ${failedReason}`);
});

// ================= GMAIL SETUP =================

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.BACKEND_URL}/auth/google/callback`
);

function loadGmailCredentials() {
  if (process.env.GMAIL_CREDENTIALS) {
    try {
      const credentials = JSON.parse(process.env.GMAIL_CREDENTIALS);
      oauth2Client.setCredentials(credentials);
      log.info('Gmail credentials loaded from environment');
      return true;
    } catch (err) {
      log.error('Invalid GMAIL_CREDENTIALS JSON:', err.message);
      return false;
    }
  }

  if (!IS_PROD) {
    try {
      const tokenData = fs.readFileSync('gmail-token.json', 'utf8');
      oauth2Client.setCredentials(JSON.parse(tokenData));
      log.info('Gmail token loaded from gmail-token.json');
      return true;
    } catch {
      log.warn('No gmail-token.json found. Run "node setup-gmail.js" to set up.');
    }
  }

  return false;
}

const gmailReady = loadGmailCredentials();

oauth2Client.on('tokens', (tokens) => {
  if (tokens.refresh_token && !IS_PROD) {
    try {
      fs.writeFileSync('gmail-token.json', JSON.stringify(tokens, null, 2));
      log.info('Gmail token refreshed and saved');
    } catch (err) {
      log.error('Failed to save Gmail token:', err.message);
    }
  }
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// ================= EMAIL WORKER =================

const emailWorker = new Worker(
  'emails',
  async (job) => {
    const { to, subject, html } = job.data;

    const message = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      html,
    ].join('\r\n');

    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage },
    });

    log.info(`Email sent → ${to} | "${subject}"`);
    return { success: true };
  },
  {
    connection:  redis,
    concurrency: 5,
  }
);

emailWorker.on('failed', (job, err) => {
  log.error(`Email failed [${job?.data?.to}] after ${job?.attemptsMade} attempts: ${err.message}`);
});

// ================= VALIDATION SCHEMAS =================

const subscribeSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid username format'),
  email:    z.string().email(),
  timezone: z.string().refine(
    (tz) => { try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; } },
    { message: 'Invalid timezone' }
  ),
});

const tokenSchema = z.object({
  token: z.string().uuid(),
});

// ================= LEETCODE HELPERS =================

const leetcodeCache = new Map(); // slug → { solved: bool, ts: number }
const CACHE_TTL_MS  = 5 * 60 * 1000; // 5 minutes

async function validLeetCode(username) {
  try {
    const res = await axios.get(`${LEETCODE_API}/${username}`, { timeout: 8000 });
    return res.status === 200 && res.data && !res.data.errors;
  } catch {
    return false;
  }
}

async function getDailyProblem() {
  const res  = await axios.get(`${LEETCODE_API}/daily`, { timeout: 10000 });
  const data = res.data;
  const title = data.questionTitle || data.title;
  if (!title) throw new Error('Could not parse daily problem from LeetCode API');
  return { title, slug: data.titleSlug };
}

async function solvedToday(username, slug) {
  const cacheKey = `${username}:${slug}`;
  const cached   = leetcodeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.solved;

  try {
    const res = await axios.get(
      `${LEETCODE_API}/${username}/acSubmission?limit=20`,
      { timeout: 10000 }
    );

    if (res.status !== 200) return false;

    const submissions =
      res.data.submission ?? res.data.data ?? (Array.isArray(res.data) ? res.data : null);

    if (!submissions) return false;

    const todayStr = new Date().toDateString();
    const solved   = submissions.some(
      (s) => s?.titleSlug === slug && new Date(s.timestamp * 1000).toDateString() === todayStr
    );

    leetcodeCache.set(cacheKey, { solved, ts: Date.now() });
    return solved;
  } catch (err) {
    log.warn(`solvedToday error for ${username}:`, err.message);
    return false;
  }
}

// ================= EMAIL TEMPLATES =================

function verifyEmailHtml(verifyLink) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',sans-serif">
  <div style="max-width:520px;margin:40px auto;background:#1e293b;border-radius:12px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#667eea,#764ba2);padding:32px;text-align:center">
      <h1 style="color:white;margin:0;font-size:22px;font-weight:700">LeetCode Daily Notifier</h1>
    </div>
    <div style="padding:32px">
      <h2 style="color:#e2e8f0;margin:0 0 12px;font-size:18px">Confirm your email</h2>
      <p style="color:#94a3b8;margin:0 0 24px;line-height:1.6">
        Click the button below to verify your email and start receiving daily LeetCode reminders.
      </p>
      <a href="${verifyLink}"
         style="display:inline-block;padding:13px 28px;background:linear-gradient(135deg,#667eea,#764ba2);
                color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">
        Verify Email →
      </a>
      <p style="color:#475569;margin:24px 0 0;font-size:12px;line-height:1.5">
        If you didn't request this, you can safely ignore this email.<br>
        Link expires in 7 days.
      </p>
    </div>
  </div>
</body>
</html>`.trim();
}

function reminderEmailHtml({ title, slug, unsubLink, slot }) {
  const problemUrl = `https://leetcode.com/problems/${slug}/`;
  const greetings  = {
    morning:   '🌅 Good morning! Time to tackle today\'s LeetCode problem.',
    afternoon: '☀️ Afternoon check-in — have you solved today\'s problem yet?',
    night:     '🌙 Last chance! Don\'t break your streak.',
  };

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',sans-serif">
  <div style="max-width:520px;margin:40px auto;background:#1e293b;border-radius:12px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#667eea,#764ba2);padding:28px 32px">
      <h1 style="color:white;margin:0;font-size:18px;font-weight:700">LeetCode Daily Notifier</h1>
    </div>
    <div style="padding:32px">
      <p style="color:#94a3b8;margin:0 0 20px;font-size:15px;line-height:1.6">${greetings[slot] || greetings.morning}</p>
      <div style="background:#0f172a;border:1px solid rgba(102,126,234,0.3);border-radius:10px;padding:20px;margin-bottom:24px">
        <p style="color:#64748b;font-size:11px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;margin:0 0 8px">Today's Problem</p>
        <p style="color:#e2e8f0;font-size:17px;font-weight:600;margin:0">${title}</p>
      </div>
      <a href="${problemUrl}"
         style="display:inline-block;padding:13px 28px;background:linear-gradient(135deg,#667eea,#764ba2);
                color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">
        Solve Now →
      </a>
      <p style="color:#334155;margin:28px 0 0;font-size:11px">
        <a href="${unsubLink}" style="color:#475569">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`.trim();
}

// ================= EXPRESS APP =================

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [
      'https://leetcode-notifier-js.vercel.app/',
      'https://leetcode-notifier-js.vercel.app'
    ];
    
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '16kb' }));

// Request logger
app.use((req, _res, next) => {
  log.info(`${req.method} ${req.path}`);
  next();
});

// Rate limiters
const subscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  message:  { error: 'Too many requests, please try again later' },
});

const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      10,
  message:  { error: 'Too many requests' },
});

// ================= ROUTES =================

app.post('/api/subscribe', subscribeLimiter, async (req, res) => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const { username, email, timezone } = parsed.data;

  const isValidUser = await validLeetCode(username);
  if (!isValidUser) {
    return res.status(400).json({ error: 'LeetCode username not found' });
  }

  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('users')
      .select('email_verified, verification_token, unsubscribed')
      .eq('email', email)
      .maybeSingle();

    if (fetchErr) throw fetchErr;

    if (existing) {
      if (existing.email_verified && !existing.unsubscribed) {
        return res.status(200).json({ message: 'Already subscribed' });
      }

      if (existing.email_verified && existing.unsubscribed) {
        const { error: updateErr } = await supabase
          .from('users')
          .update({ unsubscribed: false, leetcode_username: username, timezone, last_sent_date: null, last_sent_slot: null })
          .eq('email', email);
        if (updateErr) throw updateErr;
        return res.status(200).json({ message: 'Re-subscribed successfully!' });
      }

      // Pending verification — resend
      const link = `${FRONTEND_URL}/verify?token=${existing.verification_token}`;
      await emailQueue.add('verify', { to: email, subject: 'Verify your subscription', html: verifyEmailHtml(link) });
      return res.status(200).json({ message: 'Verification email re-sent' });
    }

    const token = crypto.randomUUID();
    const { error: insertErr } = await supabase.from('users').insert({
      leetcode_username: username,
      email,
      timezone,
      email_verified:     false,
      verification_token: token,
      unsubscribed:       false,
    });
    if (insertErr) throw insertErr;

    const link = `${FRONTEND_URL}/verify?token=${token}`;
    await emailQueue.add('verify', { to: email, subject: 'Verify your subscription', html: verifyEmailHtml(link) });

    return res.status(201).json({ message: 'Verification email sent. Please check your inbox.' });
  } catch (err) {
    log.error('Subscribe error:', err.message);
    return res.status(500).json({ error: 'Subscription failed. Please try again.' });
  }
});

app.post('/api/verify', async (req, res) => {
  const { token } = req.body;

  try {

    // Find user first
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('email_verified')
      .eq('verification_token', token)
      .single();

    // Invalid token
    if (fetchError || !user) {
      return res.status(400).json({
        error: 'Invalid verification link'
      });
    }

    // Already verified
    if (user.email_verified) {
      return res.status(200).json({
        message: 'Email already verified'
      });
    }

    // Verify user
    const { error: updateError } = await supabase
      .from('users')
      .update({ email_verified: true })
      .eq('verification_token', token);

    if (updateError) throw updateError;

    return res.status(200).json({
      message: 'Email verified'
    });

  } catch (err) {
    console.error('Verify error:', err);

    return res.status(500).json({
      error: 'Verification failed'
    });
  }
});

app.post('/api/unsubscribe', verifyLimiter, async (req, res) => {
  const parsed = tokenSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid token' });
  }

  const { token } = parsed.data;

  try {
    const { data, error } = await supabase
      .from('users')
      .update({ unsubscribed: true })
      .eq('verification_token', token)
      .select('id');

    if (error) throw error;
    if (!data?.length) {
      return res.status(400).json({ error: 'Invalid unsubscribe link' });
    }

    return res.status(200).json({ message: 'Unsubscribed successfully' });
  } catch (err) {
    log.error('Unsubscribe error:', err.message);
    return res.status(500).json({ error: 'Unsubscribe failed. Please try again.' });
  }
});

// ================= SLOT CONFIGURATION =================

const SLOTS = [
  { name: 'morning',   hourStart: 8,  hourEnd: 9,  subject: "Today's LeetCode problem" },
  { name: 'afternoon', hourStart: 14, hourEnd: 15, subject: 'Afternoon reminder — LeetCode' },
  { name: 'night',     hourStart: 19, hourEnd: 20, subject: 'Final reminder — LeetCode' },
  { name: 'test',      hourStart: 0,  hourEnd: 23, subject: 'Daily LeetCode problem' }, // Always enabled for testing
];

function getSlotForHour(hour) {
  return SLOTS.find((s) => hour >= s.hourStart && hour <= s.hourEnd);
}

function getEmailTemplate(title, slug, unsubLink, slot) {
  const problemUrl = `https://leetcode.com/problems/${slug}/`;
  
  const templates = {
    morning: `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; background: #f8f9fa; border-radius: 8px;">
      <h2 style="color: #1f2937; margin: 0 0 12px 0; font-size: 18px;">Good morning! 🌅</h2>
      <div style="background: white; padding: 16px; border-radius: 6px; border-left: 4px solid #3b82f6;">
        <p style="color: #6b7280; margin: 0 0 8px 0; font-size: 14px;">Today's problem:</p>
        <p style="color: #1f2937; margin: 0; font-size: 16px; font-weight: 600;">${title}</p>
      </div>
      <a href="${problemUrl}" style="display: inline-block; margin-top: 16px; padding: 10px 20px; background: #3b82f6; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">Solve Now →</a>
      <p style="color: #9ca3af; font-size: 13px; margin: 12px 0 0 0;">Start your day with coding!</p>
      <p style="color: #d1d5db; margin: 20px 0 0 0; font-size: 12px;">
        <a href="${unsubLink}" style="color: #9ca3af; text-decoration: none;">Unsubscribe</a>
      </p>
    </div>`,
    
    afternoon: `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; background: #f8f9fa; border-radius: 8px;">
      <h2 style="color: #1f2937; margin: 0 0 12px 0; font-size: 18px;">Afternoon check-in ☀️</h2>
      <div style="background: white; padding: 16px; border-radius: 6px; border-left: 4px solid #f59e0b;">
        <p style="color: #6b7280; margin: 0 0 8px 0; font-size: 14px;">Don't forget to solve:</p>
        <p style="color: #1f2937; margin: 0; font-size: 16px; font-weight: 600;">${title}</p>
      </div>
      <a href="${problemUrl}" style="display: inline-block; margin-top: 16px; padding: 10px 20px; background: #f59e0b; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">Solve Now →</a>
      <p style="color: #9ca3af; font-size: 13px; margin: 12px 0 0 0;">You've got this! 💪</p>
      <p style="color: #d1d5db; margin: 20px 0 0 0; font-size: 12px;">
        <a href="${unsubLink}" style="color: #9ca3af; text-decoration: none;">Unsubscribe</a>
      </p>
    </div>`,
    
    night: `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; background: #f8f9fa; border-radius: 8px;">
      <h2 style="color: #1f2937; margin: 0 0 12px 0; font-size: 18px;">Last chance! 🌙</h2>
      <div style="background: white; padding: 16px; border-radius: 6px; border-left: 4px solid #ef4444;">
        <p style="color: #6b7280; margin: 0 0 8px 0; font-size: 14px;">Complete today's problem:</p>
        <p style="color: #1f2937; margin: 0; font-size: 16px; font-weight: 600;">${title}</p>
      </div>
      <a href="${problemUrl}" style="display: inline-block; margin-top: 16px; padding: 10px 20px; background: #ef4444; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">Solve Now →</a>
      <p style="color: #9ca3af; font-size: 13px; margin: 12px 0 0 0;">End your day with a win! ✨</p>
      <p style="color: #d1d5db; margin: 20px 0 0 0; font-size: 12px;">
        <a href="${unsubLink}" style="color: #9ca3af; text-decoration: none;">Unsubscribe</a>
      </p>
    </div>`,
    
    test: `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; background: #f8f9fa; border-radius: 8px;">
      <h2 style="color: #1f2937; margin: 0 0 12px 0; font-size: 18px;">Daily Problem 🧪</h2>
      <div style="background: white; padding: 16px; border-radius: 6px; border-left: 4px solid #8b5cf6;">
        <p style="color: #6b7280; margin: 0 0 8px 0; font-size: 14px;">Today's challenge:</p>
        <p style="color: #1f2937; margin: 0; font-size: 16px; font-weight: 600;">${title}</p>
      </div>
      <a href="${problemUrl}" style="display: inline-block; margin-top: 16px; padding: 10px 20px; background: #8b5cf6; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">Solve Now →</a>
      <p style="color: #9ca3af; font-size: 13px; margin: 12px 0 0 0;">Keep grinding! 🔥</p>
      <p style="color: #d1d5db; margin: 20px 0 0 0; font-size: 12px;">
        <a href="${unsubLink}" style="color: #9ca3af; text-decoration: none;">Unsubscribe</a>
      </p>
    </div>`
  };

  return templates[slot] || templates.test;
}

app.post('/api/scheduler', async (req, res) => {
  // Constant-time comparison to prevent timing attacks
  const incomingSecret = req.body?.secret ?? '';
  const expectedSecret = process.env.CRON_SECRET ?? '';
  const secretsMatch   = crypto.timingSafeEqual(
    Buffer.from(incomingSecret.padEnd(64)),
    Buffer.from(expectedSecret.padEnd(64))
  );

  if (!secretsMatch) {
    log.warn('Scheduler: unauthorized attempt from', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { data: users, error: usersErr } = await supabase
      .from('users')
      .select('id, leetcode_username, email, timezone, last_sent_date, last_sent_slot, verification_token')
      .eq('email_verified', true)
      .eq('unsubscribed', false);

    if (usersErr) throw usersErr;
    if (!users?.length) {
      return res.status(200).json({ message: 'No subscribers to notify', sent: 0 });
    }

    const { title, slug } = await getDailyProblem();
    const todayStr = new Date().toISOString().split('T')[0];

    let sent = 0;
    let skipped = 0;

    // Batch solvedToday checks to avoid serial awaits slowing down large user lists
    const userResults = await Promise.allSettled(
      users.map(async (user) => {
        try {
          // Calculate user's local hour based on their timezone
          const userLocalTime = new Date(
            new Date().toLocaleString('en-US', { timeZone: user.timezone })
          );
          const localHour = userLocalTime.getHours();

          // Find the slot that matches the user's local hour
          const slot = getSlotForHour(localHour);
          if (!slot) {
            return { skip: true, reason: 'not in a send window', user: user.email };
          }

          // Check if we already sent this slot today
          if (user.last_sent_date === todayStr && user.last_sent_slot === slot.name) {
            return { skip: true, reason: 'already sent this slot', user: user.email };
          }

          // Check if user already solved today's problem
          const alreadySolved = await solvedToday(user.leetcode_username, slug);
          if (alreadySolved) {
            return { skip: true, reason: 'already solved', user: user.email };
          }

          // Send email
          const unsubLink = `${FRONTEND_URL}/unsubscribe?token=${user.verification_token}`;
          const html = getEmailTemplate(title, slug, unsubLink, slot.name);
          
          await emailQueue.add('reminder', {
            to: user.email,
            subject: slot.subject,
            html: html,
          });

          // Update last sent info
          await supabase
            .from('users')
            .update({ last_sent_date: todayStr, last_sent_slot: slot.name })
            .eq('id', user.id);

          return { skip: false, user: user.email, slot: slot.name };
        } catch (err) {
          log.error(`Scheduler error for user ${user.id}:`, err.message);
          return { skip: true, reason: 'error', user: user.email };
        }
      })
    );

    // Process results
    for (const result of userResults) {
      if (result.status === 'fulfilled') {
        if (result.value.skip) {
          skipped++;
          log.info(`Skipped ${result.value.user} (${result.value.reason})`);
        } else {
          sent++;
          log.info(`Sent to ${result.value.user} (${result.value.slot})`);
        }
      } else {
        skipped++;
        log.error(`Promise rejected:`, result.reason);
      }
    }

    log.info(`Scheduler done — sent: ${sent}, skipped: ${skipped}`);
    return res.status(200).json({ message: 'Scheduler completed', sent, skipped });
  } catch (err) {
    log.error('Scheduler fatal error:', err.message);
    return res.status(500).json({ error: 'Scheduler failed' });
  }
});

// ================= GOOGLE OAUTH =================

app.get('/auth/google', (_req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       ['https://www.googleapis.com/auth/gmail.send'],
  });
  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect(`${FRONTEND_URL}?auth=failed`);

  try {
    const { tokens } = await oauth2Client.getToken(String(code));
    oauth2Client.setCredentials(tokens);

    if (!IS_PROD && tokens.refresh_token) {
      fs.writeFileSync('gmail-token.json', JSON.stringify(tokens, null, 2));
      log.info('Gmail token saved to gmail-token.json');
    }

    res.redirect(`${FRONTEND_URL}?auth=success`);
  } catch (err) {
    log.error('OAuth callback error:', err.message);
    res.redirect(`${FRONTEND_URL}?auth=failed`);
  }
});

// ================= HEALTH CHECK =================

app.get('/health', async (_req, res) => {
  const checks = {
    status: 'ok',
    uptime: process.uptime(),
    gmail:  gmailReady,
    redis:  redis.status === 'ready',
    ts:     new Date().toISOString(),
  };

  try {
    await supabase.from('users').select('id').limit(1);
    checks.supabase = true;
  } catch {
    checks.supabase = false;
    checks.status   = 'degraded';
  }

  const httpStatus = checks.status === 'ok' ? 200 : 503;
  res.status(httpStatus).json(checks);
});

// ================= ERROR HANDLER =================

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  log.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ================= GRACEFUL SHUTDOWN =================

async function shutdown(signal) {
  log.info(`${signal} received — shutting down gracefully`);
  try {
    await emailWorker.close();
    await emailQueue.close();
    await redis.quit();
    log.info('Cleanup complete');
  } catch (err) {
    log.error('Shutdown error:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException',  (err) => log.error('Uncaught exception:',  err));
process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err));

// ================= START =================

app.listen(PORT, () => {
  log.info(`Server running on port ${PORT} [${NODE_ENV}]`);
  if (!gmailReady) log.warn('Gmail not configured — emails will fail. Run "node setup-gmail.js".');
});