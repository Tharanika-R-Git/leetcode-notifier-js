import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, useSearchParams, useNavigate, Routes, Route } from 'react-router-dom';

const API_URL = 'https://leetcode-notifier-js-backend.onrender.com';


function SubscribePage() {
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [messageType, setMessageType] = useState('');

  const timezones = Intl.supportedValuesOf('timeZone');

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const handleSubscribe = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage('');
    setMessageType('');

    try {
      const res = await fetch(`${API_URL}/api/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await res.json();

      if (res.ok) {
        setMessageType('success');
        setMessage(data.message || 'Verification email sent!');
        setFormData({
          username: '',
          email: '',
          timezone: formData.timezone,
        });
      } else {
        setMessageType('error');
        setMessage(data.error || 'Something went wrong');
      }
    } catch (err) {
      setMessageType('error');
      setMessage('Failed to connect to server');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>📬 LeetCode Daily Email Notifier</h1>
        <p style={styles.subtitle}>Get daily LeetCode problem reminders in your inbox</p>

        <form onSubmit={handleSubscribe} style={styles.form}>
          <div style={styles.formGroup}>
            <label style={styles.label}>LeetCode Username</label>
            <input
              name="username"
              placeholder="e.g., leetcode_user"
              value={formData.username}
              onChange={handleChange}
              required
              style={styles.input}
            />
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Email Address</label>
            <input
              name="email"
              type="email"
              placeholder="your@email.com"
              value={formData.email}
              onChange={handleChange}
              required
              style={styles.input}
            />
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Timezone</label>
            <select
              name="timezone"
              value={formData.timezone}
              onChange={handleChange}
              style={styles.input}
            >
              {timezones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              ...styles.button,
              opacity: loading ? 0.6 : 1,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'Subscribing...' : 'Subscribe'}
          </button>
        </form>

        {message && (
          <div
            style={{
              ...styles.message,
              backgroundColor:
                messageType === 'success' ? '#d1fae5' : '#fee2e2',
              borderLeftColor:
                messageType === 'success' ? '#10b981' : '#ef4444',
              color: messageType === 'success' ? '#065f46' : '#991b1b',
            }}
          >
            {message}
          </div>
        )}

        <div style={styles.infoBox}>
          <h3 style={styles.infoTitle}>📧 How it works:</h3>
          <ul style={styles.infoList}>
            <li>✅ Subscribe with your LeetCode username and email</li>
            <li>✅ Verify your email (check spam folder)</li>
            <li>✅ Receive 3 daily reminders (8am, 2pm, 8pm)</li>
            <li>✅ Stop when you solve the daily problem</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function VerifyPage() {
  const [searchParams] = useSearchParams();
  const [message, setMessage] = useState('Verifying...');
  const [status, setStatus] = useState('loading');
  const navigate = useNavigate();

  useEffect(() => {
    const verifyEmail = async () => {
      const token = searchParams.get('token');

      if (!token) {
        setMessage('❌ Invalid verification link');
        setStatus('error');
        return;
      }

      try {
        const res = await fetch(`${API_URL}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        const data = await res.json();

        if (res.ok) {
          setMessage('✅ Email verified successfully!');
          setStatus('success');
          setTimeout(() => navigate('/'), 3000);
        } else {
          setMessage(data.error || '❌ Verification failed');
          setStatus('error');
        }
      } catch (err) {
        setMessage('❌ Connection error');
        setStatus('error');
        console.error(err);
      }
    };

    verifyEmail();
  }, [searchParams, navigate]);

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Email Verification</h1>

        <div
          style={{
            ...styles.message,
            backgroundColor:
              status === 'success' ? '#d1fae5' : status === 'error' ? '#fee2e2' : '#eff6ff',
            borderLeftColor:
              status === 'success' ? '#10b981' : status === 'error' ? '#ef4444' : '#3b82f6',
            color:
              status === 'success' ? '#065f46' : status === 'error' ? '#991b1b' : '#1e40af',
            textAlign: 'center',
            padding: '20px',
            fontSize: '16px',
          }}
        >
          {message}
        </div>

        {status === 'success' && (
          <p style={{ textAlign: 'center', marginTop: '20px', color: '#666' }}>
            Redirecting to home page...
          </p>
        )}

        {status === 'error' && (
          <button
            onClick={() => navigate('/')}
            style={styles.button}
          >
            Back to Home
          </button>
        )}
      </div>
    </div>
  );
}

function UnsubscribePage() {
  const [searchParams] = useSearchParams();
  const [message, setMessage] = useState('Processing...');
  const [status, setStatus] = useState('loading');
  const navigate = useNavigate();

  useEffect(() => {
    const unsubscribe = async () => {
      const token = searchParams.get('token');

      if (!token) {
        setMessage('❌ Invalid unsubscribe link');
        setStatus('error');
        return;
      }

      try {
        const res = await fetch(`${API_URL}/api/unsubscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        const data = await res.json();

        if (res.ok) {
          setMessage('👋 You have been unsubscribed');
          setStatus('success');
          setTimeout(() => navigate('/'), 3000);
        } else {
          setMessage(data.error || '❌ Unsubscribe failed');
          setStatus('error');
        }
      } catch (err) {
        setMessage('❌ Connection error');
        setStatus('error');
        console.error(err);
      }
    };

    unsubscribe();
  }, [searchParams, navigate]);

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Unsubscribe</h1>

        <div
          style={{
            ...styles.message,
            backgroundColor:
              status === 'success' ? '#d1fae5' : status === 'error' ? '#fee2e2' : '#eff6ff',
            borderLeftColor:
              status === 'success' ? '#10b981' : status === 'error' ? '#ef4444' : '#3b82f6',
            color:
              status === 'success' ? '#065f46' : status === 'error' ? '#991b1b' : '#1e40af',
            textAlign: 'center',
            padding: '20px',
            fontSize: '16px',
          }}
        >
          {message}
        </div>

        {status === 'success' && (
          <p style={{ textAlign: 'center', marginTop: '20px', color: '#666' }}>
            Redirecting to home page...
          </p>
        )}

        {status === 'error' && (
          <button
            onClick={() => navigate('/')}
            style={styles.button}
          >
            Back to Home
          </button>
        )}
      </div>
    </div>
  );
}

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<SubscribePage />} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/unsubscribe" element={<UnsubscribePage />} />
      </Routes>
    </Router>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    padding: '20px',
  },
  card: {
    background: 'white',
    borderRadius: '12px',
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
    maxWidth: '500px',
    width: '100%',
    padding: '40px',
  },
  title: {
    margin: '0 0 10px 0',
    fontSize: '28px',
    fontWeight: 'bold',
    textAlign: 'center',
    color: '#1f2937',
  },
  subtitle: {
    textAlign: 'center',
    color: '#666',
    marginBottom: '30px',
    fontSize: '14px',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  label: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#374151',
  },
  input: {
    padding: '12px 15px',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    fontSize: '14px',
    fontFamily: 'inherit',
    transition: 'border-color 0.2s',
    boxSizing: 'border-box',
  },
  button: {
    padding: '12px 24px',
    background: '#667eea',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontSize: '16px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'background 0.2s',
    marginTop: '10px',
  },
  message: {
    padding: '15px',
    borderRadius: '8px',
    marginTop: '20px',
    fontSize: '14px',
    borderLeft: '4px solid',
    animation: 'slideIn 0.3s ease-in-out',
  },
  infoBox: {
    marginTop: '30px',
    padding: '20px',
    background: '#f3f4f6',
    borderRadius: '8px',
    borderLeft: '4px solid #667eea',
  },
  infoTitle: {
    margin: '0 0 12px 0',
    fontSize: '16px',
    fontWeight: '600',
    color: '#1f2937',
  },
  infoList: {
    margin: 0,
    paddingLeft: '20px',
    color: '#666',
    fontSize: '14px',
    lineHeight: '1.8',
  },
};

export default App;