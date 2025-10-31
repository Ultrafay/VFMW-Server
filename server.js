require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// Configuration
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

const openai = new OpenAI({ 
  apiKey: OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID, // Optional
  project: process.env.OPENAI_PROJECT_ID  // Optional
});

// Store conversation threads
const conversationThreads = new Map();

// Logging helper
function log(emoji, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${emoji} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// Send message to Freshchat
async function sendFreshchatMessage(conversationId, message) {
  try {
    log('📤', `Attempting to send message to conversation: ${conversationId}`);
    log('📝', `Message content: ${message.substring(0, 100)}...`);
    
    const payload = {
      messages: [{
        message_parts: [{
          text: {
            content: message
          }
        }],
        message_type: 'normal',
        actor_type: 'system'
      }]
    };
    
    log('📦', `Payload:`, payload);
    
    const response = await axios.post(
      `${FRESHCHAT_API_URL}/conversations/${conversationId}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    log('✅', `Message sent successfully to conversation ${conversationId}`);
    log('📬', `Response:`, response.data);
    return response.data;
  } catch (error) {
    log('❌', `Error sending Freshchat message to ${conversationId}`);
    log('❌', `Error status: ${error.response?.status}`);
    log('❌', `Error data:`, error.response?.data);
    log('❌', `Error message: ${error.message}`);
    
    // Try alternative format if first attempt fails
    if (error.response?.status === 400) {
      log('🔄', 'Trying alternative message format...');
      return await sendFreshchatMessageAlt(conversationId, message);
    }
    
    throw error;
  }
}

// Alternative message format
async function sendFreshchatMessageAlt(conversationId, message) {
  try {
    const payload = {
      message_type: 'normal',
      message_parts: [{
        text: {
          content: message
        }
      }],
      actor_type: 'system'
    };
    
    log('📦', `Alternative payload:`, payload);
    
    const response = await axios.post(
      `${FRESHCHAT_API_URL}/conversations/${conversationId}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    log('✅', `Message sent with alternative format`);
    return response.data;
  } catch (error) {
    log('❌', `Alternative format also failed:`, error.response?.data);
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
    let thread;
    if (!threadId) {
      thread = await openai.beta.threads.create();
      log('🆕', `New thread created: ${thread.id}`);
    } else {
      thread = { id: threadId };
      log('♻️', `Using existing thread: ${threadId}`);
    }

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: userMessage
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: ASSISTANT_ID
    });

    log('⏳', 'Waiting for assistant response...');

    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    let attempts = 0;
    const maxAttempts = 60; // Increased to 60 seconds

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

    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data[0].content[0].text.value;

    const needsEscalation = assistantMessage.includes('ESCALATE_TO_HUMAN');
    
    let cleanMessage = assistantMessage;
    let escalationReason = '';
    
    if (needsEscalation) {
      const match = assistantMessage.match(/ESCALATE_TO_HUMAN:\s*(.+)/);
      escalationReason = match ? match[1].trim() : 'User request';
      
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

// Process message asynchronously (after responding to webhook)
async function processMessageAsync(conversationId, messageContent) {
  try {
    log('🔄', `Processing message asynchronously for ${conversationId}`);

    let threadId = conversationThreads.get(conversationId);

    const { response, threadId: newThreadId, needsEscalation, escalationReason } = 
      await getAssistantResponse(messageContent, threadId);

    conversationThreads.set(conversationId, newThreadId);

    await sendFreshchatMessage(conversationId, response);

    if (needsEscalation) {
      log('🚨', `Escalating: ${escalationReason}`);
      await assignToHumanAgent(conversationId);
      await sendFreshchatMessage(
        conversationId, 
        'A team member will be with you shortly. Thank you for your patience!'
      );
    }

    log('✅', `Message processing completed for ${conversationId}`);

  } catch (error) {
    log('❌', `Error processing message for ${conversationId}:`, error.message);
    
    // Send error message to user
    try {
      await sendFreshchatMessage(
        conversationId,
        "I'm having trouble processing your request right now. Let me connect you with a human agent."
      );
      await assignToHumanAgent(conversationId);
    } catch (fallbackError) {
      log('❌', 'Failed to send error message:', fallbackError.message);
    }
  }
}

// Main webhook endpoint - RESPONDS IMMEDIATELY
app.post('/freshchat-webhook', async (req, res) => {
  try {
    // RESPOND IMMEDIATELY to avoid timeout (within 3 seconds)
    res.status(200).json({ success: true, message: 'Webhook received' });
    
    log('📥', 'Webhook received and acknowledged');
    
    const { actor, action, data } = req.body;
    
    // Log webhook data for debugging
    log('📋', 'Webhook details:', {
      actor_type: actor?.actor_type,
      action: action,
      has_message: !!data?.message
    });
    
    // Only process user messages
    if (action === 'message_create' && actor?.actor_type === 'user') {
      
      const conversationId = data?.message?.conversation_id;
      const messageContent = data?.message?.message_parts?.[0]?.text?.content;
      
      if (!conversationId || !messageContent) {
        log('⚠️', 'Missing conversation ID or message content');
        return;
      }

      log('💬', `User message in ${conversationId}: "${messageContent}"`);

      // Process message ASYNCHRONOUSLY (don't wait)
      processMessageAsync(conversationId, messageContent)
        .catch(err => log('❌', 'Async processing error:', err.message));
      
    } else {
      log('ℹ️', `Ignoring webhook: ${action} from ${actor?.actor_type}`);
    }
    
  } catch (error) {
    log('❌', 'Webhook error:', error.message);
    // Already responded, so just log the error
  }
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeThreads: conversationThreads.size
  });
});

// Test configuration
app.get('/test', (req, res) => {
  res.status(200).json({
    status: 'Server running',
    version: '1.0.0',
    config: {
      freshchat: !!FRESHCHAT_API_KEY,
      openai: !!OPENAI_API_KEY,
      assistant: !!ASSISTANT_ID
    },
    activeThreads: conversationThreads.size,
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    name: 'Freshchat-OpenAI Integration Server',
    version: '1.0.0',
    endpoints: {
      webhook: 'POST /freshchat-webhook',
      health: 'GET /health',
      test: 'GET /test'
    },
    status: 'running'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 Freshchat-OpenAI Integration Server Started');
  console.log('='.repeat(60));
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔗 Webhook: POST /freshchat-webhook`);
  console.log(`❤️  Health: GET /health`);
  console.log(`🧪 Test: GET /test`);
  console.log('='.repeat(60) + '\n');
});
