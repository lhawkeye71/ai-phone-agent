// AI Phone Agent System
// This system handles incoming calls, collects user info, and sends follow-up texts

// Load environment variables first
require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const sqlite3 = require('sqlite3').verbose();
const app = express();

// Configuration
const config = {
    twilio: {
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        phoneNumber: process.env.TWILIO_PHONE_NUMBER
    },
    openai: {
        apiKey: process.env.OPENAI_API_KEY
    },
    port: process.env.PORT || 3000
};

// Initialize services
const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
const openai = new OpenAI({ apiKey: config.openai.apiKey });

// Initialize database
const db = new sqlite3.Database('customer_data.db');

// Create tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number TEXT UNIQUE,
        name TEXT,
        favorite_color TEXT,
        steak_preference TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS call_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_sid TEXT,
        phone_number TEXT,
        conversation_state TEXT,
        collected_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Steak temperature mapping
const steakTemperatures = {
    'rare': { temp: '120-125°F', time: '2-3 minutes per side' },
    'medium rare': { temp: '130-135°F', time: '3-4 minutes per side' },
    'medium': { temp: '135-145°F', time: '4-5 minutes per side' },
    'medium well': { temp: '145-155°F', time: '5-6 minutes per side' },
    'well done': { temp: '155°F+', time: '6+ minutes per side' }
};

// AI Assistant for call handling
class CallAssistant {
    constructor() {
        this.systemPrompt = `You are a friendly phone assistant collecting customer information. 
        Your job is to:
        1. Greet the caller warmly
        2. Collect their name
        3. Ask for their favorite color
        4. Ask how they like their steak cooked (rare, medium rare, medium, medium well, well done)
        
        Keep responses brief and conversational. When you have all three pieces of information, 
        thank them and let them know they'll receive a text with cooking instructions.
        
        Always respond in a natural, friendly tone as if speaking on the phone.`;
    }

    async generateResponse(conversationHistory, userInput) {
        const messages = [
            { role: 'system', content: this.systemPrompt },
            ...conversationHistory,
            { role: 'user', content: userInput }
        ];

        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: messages,
            max_tokens: 150,
            temperature: 0.7
        });

        return response.choices[0].message.content;
    }

    extractInformation(conversation) {
        // Simple extraction logic - in production, use more sophisticated NLP
        const text = conversation.toLowerCase();
        const info = {};

        // Extract name (look for "my name is" or "i'm" patterns)
        const namePatterns = [/my name is (\w+)/i, /i'm (\w+)/i, /this is (\w+)/i];
        for (const pattern of namePatterns) {
            const match = conversation.match(pattern);
            if (match) {
                info.name = match[1];
                break;
            }
        }

        // Extract favorite color
        const colors = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'black', 'white', 'brown'];
        for (const color of colors) {
            if (text.includes(color)) {
                info.favoriteColor = color;
                break;
            }
        }

        // Extract steak preference
        const steakPrefs = ['rare', 'medium rare', 'medium well', 'medium', 'well done'];
        for (const pref of steakPrefs) {
            if (text.includes(pref)) {
                info.steakPreference = pref;
                break;
            }
        }

        return info;
    }
}

const callAssistant = new CallAssistant();

// Webhook endpoint for incoming calls
app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    const from = req.body.From;

    // Initialize or get existing session
    const session = await getOrCreateSession(callSid, from);
    
    twiml.say({ voice: 'alice' }, 
        "Hello! I'm calling to collect some quick information for our steak cooking service. This will just take a minute.");
    
    twiml.gather({
        input: 'speech',
        timeout: 10,
        action: '/gather',
        method: 'POST'
    });

    res.type('text/xml');
    res.send(twiml.toString());
});

// Handle speech input
app.post('/gather', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const speechResult = req.body.SpeechResult || '';
    const callSid = req.body.CallSid;
    const from = req.body.From;

    try {
        // Get session data
        const session = await getSession(callSid);
        let conversationHistory = session.conversation_state ? 
            JSON.parse(session.conversation_state) : [];
        
        // Add user input to conversation
        conversationHistory.push({ role: 'user', content: speechResult });

        // Generate AI response
        const aiResponse = await callAssistant.generateResponse(
            conversationHistory.slice(-6), // Keep last 6 messages for context
            speechResult
        );

        // Add AI response to conversation
        conversationHistory.push({ role: 'assistant', content: aiResponse });

        // Extract information from entire conversation
        const fullConversation = conversationHistory
            .map(msg => msg.content)
            .join(' ');
        const extractedInfo = callAssistant.extractInformation(fullConversation);

        // Update session
        await updateSession(callSid, conversationHistory, extractedInfo);

        // Check if we have all required information
        if (extractedInfo.name && extractedInfo.favoriteColor && extractedInfo.steakPreference) {
            // Save to database
            await saveCustomerData(from, extractedInfo);
            
            // Send follow-up text
            await sendSteakInstructions(from, extractedInfo);
            
            twiml.say({ voice: 'alice' }, 
                `Perfect! Thanks ${extractedInfo.name}. I've got your information and you'll receive a text with your personalized steak cooking instructions shortly. Have a great day!`);
            
            twiml.hangup();
        } else {
            // Continue conversation
            twiml.say({ voice: 'alice' }, aiResponse);
            
            twiml.gather({
                input: 'speech',
                timeout: 10,
                action: '/gather',
                method: 'POST'
            });
        }

    } catch (error) {
        console.error('Error processing call:', error);
        twiml.say({ voice: 'alice' }, 
            "I'm sorry, I'm having trouble processing that. Let me try again.");
        
        twiml.gather({
            input: 'speech',
            timeout: 10,
            action: '/gather',
            method: 'POST'
        });
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

// Database helper functions
function getOrCreateSession(callSid, phoneNumber) {
    return new Promise((resolve, reject) => {
        db.get(
            "SELECT * FROM call_sessions WHERE call_sid = ?",
            [callSid],
            (err, row) => {
                if (err) {
                    reject(err);
                } else if (row) {
                    resolve(row);
                } else {
                    // Create new session
                    db.run(
                        "INSERT INTO call_sessions (call_sid, phone_number, conversation_state, collected_data) VALUES (?, ?, ?, ?)",
                        [callSid, phoneNumber, '[]', '{}'],
                        function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve({
                                    id: this.lastID,
                                    call_sid: callSid,
                                    phone_number: phoneNumber,
                                    conversation_state: '[]',
                                    collected_data: '{}'
                                });
                            }
                        }
                    );
                }
            }
        );
    });
}

function getSession(callSid) {
    return new Promise((resolve, reject) => {
        db.get(
            "SELECT * FROM call_sessions WHERE call_sid = ?",
            [callSid],
            (err, row) => {
                if (err) reject(err);
                else resolve(row);
            }
        );
    });
}

function updateSession(callSid, conversationHistory, collectedData) {
    return new Promise((resolve, reject) => {
        db.run(
            "UPDATE call_sessions SET conversation_state = ?, collected_data = ? WHERE call_sid = ?",
            [JSON.stringify(conversationHistory), JSON.stringify(collectedData), callSid],
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}

function saveCustomerData(phoneNumber, info) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT OR REPLACE INTO customers 
             (phone_number, name, favorite_color, steak_preference) 
             VALUES (?, ?, ?, ?)`,
            [phoneNumber, info.name, info.favoriteColor, info.steakPreference],
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}

// Send personalized steak cooking instructions via SMS
async function sendSteakInstructions(phoneNumber, customerInfo) {
    const { name, favoriteColor, steakPreference } = customerInfo;
    const tempInfo = steakTemperatures[steakPreference.toLowerCase()] || steakTemperatures['medium'];
    
    const message = `Hi ${name}! 🥩 Here are your personalized ${favoriteColor} steak cooking instructions:

For ${steakPreference} steak:
🌡️ Cook to ${tempInfo.temp}
⏱️ About ${tempInfo.time}
🎨 Pro tip: Use a ${favoriteColor} plate for the perfect presentation!

Happy cooking! 🔥`;

    try {
        await twilioClient.messages.create({
            body: message,
            from: config.twilio.phoneNumber,
            to: phoneNumber
        });
        console.log(`Sent steak instructions to ${phoneNumber}`);
    } catch (error) {
        console.error('Error sending SMS:', error);
    }
}

// API endpoint to view customer data
app.get('/customers', (req, res) => {
    db.all("SELECT * FROM customers ORDER BY created_at DESC", (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(rows);
        }
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Start server
app.listen(config.port, () => {
    console.log(`AI Phone Agent server running on port ${config.port}`);
    console.log(`Webhook URL: https://yourdomain.com/voice`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err);
        } else {
            console.log('Database connection closed.');
        }
        process.exit(0);
    });
});