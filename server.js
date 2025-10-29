require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// Configuration from environment variables
const FRESHCHAT_API_KEY = process.env.FRESHCHAT_API_KEY;
const FRESHCHAT_API_URL = 'https://api.freshchat.com/v2';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;

// Validate environment variables
if (!FRESHCHAT_API_KEY || !OPENAI_API_KEY || !ASSISTANT_ID) {
  console.error('❌ Missing required environment variables!');
  console.error('Please set: FRESHCHAT_API_KEY, OPENAI_API_KEY, ASSISTANT_ID');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Store conversation threads in memory (use Redis/Database in production)
const conversationThreads = new Map();

// Logging helper
function log(emoji, message, data = null) {
  console.log(`${emoji} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// Send message to Freshchat
async function sendFreshchatMessage(conversationId, message) {
  try {
    const response = await axios.post(
      `${FRESHCHAT_API_URL}/conversations/${conversationId}/messages`,
      {
        message_type: 'normal',
        message_parts: [{
          text: { content: message }
        }],
        actor_type: 'agent',
        actor_id: 'bot'
      },
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    log('✅', `Message sent to conversation ${conversationId}`);
    return response.data;
  } catch (error) {
    log('❌', 'Error sending Freshchat message:', error.response?.data || error.message);
    throw error;
  }
}

// Assign conversation to human agent
async function assignToHumanAgent(conversationId) {
  try {
    await axios.put(
      `${FRESHCHAT_API_URL}/conversations/${conversationId}`,
      {
        status: 'assigned'
      },
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    log('🚨', `Conversation ${conversationId} escalated to human agent`);
    return true;
  } catch (error) {
    log('❌', 'Error escalating to agent:', error.response?.data || error.message);
    throw error;
  }
}

// Get response from OpenAI Assistant
async function getAssistantResponse(userMessage, threadId = null) {
  try {
    // Create new thread or use existing
    let thread;
    if (!threadId) {
      thread = await openai.beta.threads.create();
      log('🆕', `New thread created: ${thread.id}`);
    } else {
      thread = { id: threadId };
      log('♻️', `Using existing thread: ${threadId}`);
    }

    // Add user message
    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: userMessage
    });

    // Run assistant
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: ASSISTANT_ID
    });

    log('⏳', 'Waiting for assistant response...');

    // Poll for completion
    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds timeout

    while (runStatus.status !== 'completed' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      attempts++;

      if (runStatus.status === 'failed' || runStatus.status === 'expired') {
        throw new Error(`Assistant run ${runStatus.status}`);
      }
    }

    if (attempts >= maxAttempts) {
      throw new Error('Assistant response timeout');
    }

    // Get assistant's response
    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data[0].content[0].text.value;

    // Check for escalation
    const needsEscalation = assistantMessage.includes('ESCALATE_TO_HUMAN');
    
    let cleanMessage = assistantMessage;
    let escalationReason = '';
    
    if (needsEscalation) {
      const match = assistantMessage.match(/ESCALATE_TO_HUMAN:\s*(.+)/);
      escalationReason = match ? match[1].trim() : 'User request';
      
      // Remove escalation keyword from message
      cleanMessage = assistantMessage.replace(/ESCALATE_TO_HUMAN:.+/g, '').trim();
      
      if (!cleanMessage) {
        cleanMessage = "Let me connect you with one of our team members who can better assist you.";
      }
    }

    log('🤖', `Assistant response: ${cleanMessage.substring(0, 100)}...`);
    if (needsEscalation) {
      log('🚨', `Escalation reason: ${escalationReason}`);
    }

    return {
      response: cleanMessage,
      threadId: thread.id,
      needsEscalation,
      escalationReason
    };

  } catch (error) {
    log('❌', 'OpenAI Assistant error:', error.message);
    throw error;
  }
}

// Main webhook endpoint
app.post('/freshchat-webhook', async (req, res) => {
  try {
    log('📥', 'Webhook received');
    
    const { actor, action, data } = req.body;
    
    // Only process user messages
    if (action === 'message_create' && actor?.actor_type === 'user') {
      
      const conversationId = data?.message?.conversation_id;
      const messageContent = data?.message?.message_parts?.[0]?.text?.content;
      
      if (!conversationId || !messageContent) {
        log('⚠️', 'Missing conversation ID or message content');
        return res.status(200).json({ success: true, message: 'Invalid data' });
      }

      log('💬', `Message from ${conversationId}: ${messageContent}`);

      // Get or create thread
      let threadId = conversationThreads.get(conversationId);

      // Get AI response
      const { response, threadId: newThreadId, needsEscalation, escalationReason } = 
        await getAssistantResponse(messageContent, threadId);

      // Store thread ID
      conversationThreads.set(conversationId, newThreadId);

      // Send response to Freshchat
      await sendFreshchatMessage(conversationId, response);

      // Handle escalation
      if (needsEscalation) {
        log('🚨', `Escalating: ${escalationReason}`);
        
        // Escalate to human
        await assignToHumanAgent(conversationId);
        
        // Send follow-up message
        await sendFreshchatMessage(
          conversationId, 
          'A team member will be with you shortly. Thank you for your patience!'
        );
      }

      return res.status(200).json({ success: true });
      
    } else {
      // Not a user message
      return res.status(200).json({ success: true, message: 'Not a user message' });
    }
    
  } catch (error) {
    log('❌', 'Webhook error:', error.message);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Test configuration
app.get('/test', (req, res) => {
  res.status(200).json({
    status: 'Server running',
    config: {
      freshchat: !!FRESHCHAT_API_KEY,
      openai: !!OPENAI_API_KEY,
      assistant: !!ASSISTANT_ID
    },
    activeThreads: conversationThreads.size
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    message: 'Freshchat-OpenAI Integration Server',
    endpoints: {
      webhook: 'POST /freshchat-webhook',
      health: 'GET /health',
      test: 'GET /test'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n🚀 Server started successfully!');
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔗 Webhook URL: https://your-domain.com/freshchat-webhook`);
  console.log(`❤️  Health: http://localhost:${PORT}/health`);
  console.log(`🧪 Test: http://localhost:${PORT}/test\n`);
});
