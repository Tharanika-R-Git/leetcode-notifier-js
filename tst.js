import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import ws from 'ws';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  {
    realtime: {
      transport: ws,
    },
  }
);

async function testInsert() {
  console.log('🧪 Testing Supabase Insert...\n');

  try {
    // Test data
    const testUser = {
      leetcode_username: 'testuser123',
      email: 'test@example.com',
      timezone: 'Asia/Kolkata',
      email_verified: false,
      verification_token: crypto.randomUUID(),
      unsubscribed: false,
    };

    console.log('📝 Inserting test data:');
    console.log(JSON.stringify(testUser, null, 2));
    console.log('\n');

    // Insert
    const { data, error } = await supabase
      .from('users')
      .insert([testUser])
      .select();

    if (error) {
      console.error('❌ Insert failed:', error.message);
      return;
    }

    console.log('✅ Insert successful!');
    console.log('📊 Inserted data:');
    console.log(JSON.stringify(data, null, 2));
    console.log('\n');

    // Verify by reading
    console.log('🔍 Verifying by reading from database...\n');
    const { data: readData, error: readError } = await supabase
      .from('users')
      .select('*')
      .eq('email', 'test@example.com')
      .single();

    if (readError) {
      console.error('❌ Read failed:', readError.message);
      return;
    }

    console.log('✅ Data verified in database!');
    console.log('📊 Read data:');
    console.log(JSON.stringify(readData, null, 2));
    console.log('\n');

    // Cleanup (optional)
    console.log('🗑️  Cleaning up test data...\n');
    const { error: deleteError } = await supabase
      .from('users')
      .delete()
      .eq('email', 'test@example.com');

    if (deleteError) {
      console.error('❌ Cleanup failed:', deleteError.message);
      return;
    }

    console.log('✅ Test data cleaned up!');
    console.log('\n✨ All tests passed! Your Supabase insert is working correctly.\n');

  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

testInsert();