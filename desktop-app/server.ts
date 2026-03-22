import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000');
const LONGCAT_API_KEY = process.env.LONGCAT_API_KEY;
const LONGCAT_BASE_URL = process.env.LONGCAT_BASE_URL || 'https://api.longcat.chat/v1';
const STATE_FILE = path.join(__dirname, 'job_state.json');

interface JobState {
  prompt: string;
  steps: any[];
  currentIndex: number;
  isRunning: boolean;
  canvasImage?: string | null;
  canvasData?: any;
  components?: any[];
}

let currentJob: JobState | null = null;
let pluginSocket: WebSocket | null = null;
let streamBuffer = '';

// Load state from disk
if (fs.existsSync(STATE_FILE)) {
  try {
    currentJob = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    console.log('Loaded existing job state from disk');
  } catch (e) {
    console.error('Failed to load job state:', e);
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  console.log('Figma Plugin connected');
  pluginSocket = ws;

  // Send current state to newly connected plugin
  if (currentJob && currentJob.isRunning) {
    ws.send(JSON.stringify({ type: 'RESUME_JOB', state: currentJob }));
  }

  ws.on('message', async (data) => {
    const message = JSON.parse(data.toString());
    console.log('Received message:', message.type);

    switch (message.type) {
      case 'RUN_PROMPT':
        handleRunPrompt(message.prompt);
        break;
      case 'STOP_JOB':
        handleStopJob();
        break;
      case 'STEP_COMPLETE':
        handleStepComplete();
        break;
      case 'CANVAS_DATA':
        handleCanvasData(message.data);
        break;
      case 'CANVAS_IMAGE':
        handleCanvasImage(message.image);
        break;
      case 'COMPONENTS':
        handleComponents(message.data);
        break;
    }
  });

  ws.on('close', () => {
    console.log('Figma Plugin disconnected');
    pluginSocket = null;
    saveState();
  });
});

async function handleRunPrompt(prompt: string) {
  console.log('Running prompt:', prompt);
  
  // 1. Request canvas data, image data, AND components
  if (pluginSocket) {
    pluginSocket.send(JSON.stringify({ type: 'READ_CANVAS' }));
    pluginSocket.send(JSON.stringify({ type: 'READ_IMAGE' }));
    pluginSocket.send(JSON.stringify({ type: 'READ_COMPONENTS' }));
  }
  
  currentJob = {
    prompt,
    steps: [],
    currentIndex: 0,
    isRunning: true,
    canvasImage: undefined,
    components: undefined
  };
  saveState();
}

async function handleCanvasImage(image: string | null) {
  if (!currentJob) return;
  console.log('Received canvas image data');
  currentJob.canvasImage = image;
  saveState();
  checkReadyAndCallAI();
}

async function handleComponents(components: any[]) {
  if (!currentJob) return;
  console.log('Received component library data');
  currentJob.components = components;
  saveState();
  checkReadyAndCallAI();
}

async function handleCanvasData(canvasData: any) {
  if (!currentJob) return;
  console.log('Received canvas data');
  currentJob.canvasData = canvasData;
  saveState();
  checkReadyAndCallAI();
}

async function checkReadyAndCallAI() {
  if (!currentJob || !currentJob.isRunning || !currentJob.canvasData || currentJob.components === undefined) return;
  
  if (currentJob.canvasImage === undefined) return;

  console.log('All data ready, calling LongCat API...');
  
  try {
    const messages: any[] = [
      {
        role: 'system',
        content: `You are a world-class Figma design architect. 
        Your goal is to build professional, high-fidelity landing pages or UI components.
        
        CRITICAL RULES:
        1. Respond ONLY with a JSON array of actions.
        2. ALWAYS use Auto-Layout for frames (layoutMode: 'HORIZONTAL' | 'VERTICAL').
        3. Use appropriate spacing (itemSpacing) and padding.
        4. Colors should be modern (hex codes).
        5. Structure your actions logically (Frames first, then children).
        
        SUPPORTED ACTIONS:
        - createFrame: { name, width, height, fill, layoutMode, itemSpacing, paddingLeft, paddingRight, paddingTop, paddingBottom, primaryAxisAlignItems, counterAxisAlignItems }
        - addRectangle: { name, width, height, fill, cornerRadius, x, y }
        - addText: { content, fontSize, fill, x, y }
        - addInstance: { componentId, x, y, name } // Use this for library components
        
        AVAILABLE COMPONENTS:
        ${JSON.stringify(currentJob.components)}
        `
      }
    ];

    const userMessage: any = {
      role: 'user',
      content: [
        { type: 'text', text: `Context: ${JSON.stringify(currentJob.canvasData)}\n\nPrompt: ${currentJob.prompt}` }
      ]
    };

    if (currentJob.canvasImage) {
      userMessage.content.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${currentJob.canvasImage}` }
      });
    }

    messages.push(userMessage);

    const response = await axios({
      method: 'post',
      url: `${LONGCAT_BASE_URL}/chat/completions`,
      data: {
        model: 'longcat-v1-vision',
        messages: messages,
        stream: true
      },
      headers: { 'Authorization': `Bearer ${LONGCAT_API_KEY}` },
      responseType: 'stream'
    });

    response.data.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      streamBuffer += text;
      extractAndSendActions();
    });

    response.data.on('end', () => {
      console.log('Stream finished');
    });

  } catch (error) {
    console.error('LongCat API error:', error);
    if (pluginSocket) {
      pluginSocket.send(JSON.stringify({ type: 'ERROR', message: 'Failed to generate steps from LongCat API' }));
    }
  }
}

function sendNextStep() {
  if (!currentJob || !currentJob.isRunning || !pluginSocket) return;

  if (currentJob.currentIndex < currentJob.steps.length) {
    const step = currentJob.steps[currentJob.currentIndex];
    console.log(`Sending step ${currentJob.currentIndex + 1}/${currentJob.steps.length}:`, step.action);
    pluginSocket.send(JSON.stringify({ type: 'EXECUTE_STEP', step }));
  } else {
    console.log('Job complete!');
    currentJob.isRunning = false;
    saveState();
    pluginSocket.send(JSON.stringify({ type: 'JOB_COMPLETE' }));
  }
}

function handleStepComplete() {
  if (!currentJob) return;
  currentJob.currentIndex++;
  saveState();
  sendNextStep();
}

function handleStopJob() {
  console.log('Stopping job...');
  if (currentJob) {
    currentJob.isRunning = false;
    saveState();
  }
}

function extractAndSendActions() {
  if (!currentJob) return;

  let match;
  // This regex tries to find valid JSON objects { ... } in the stream
  // It looks for things like { "action": "..." }
  const actionRegex = /({[^{}]*})/g; 

  while ((match = actionRegex.exec(streamBuffer)) !== null) {
      try {
          const action = JSON.parse(match[1]);
          if (action.action) {
              // Add to current steps if not already added (simple check for now)
              // In a real stream we'd need more sophisticated deduplication
              currentJob.steps.push(action);
              saveState();
              
              if (currentJob.isRunning) {
                  sendNextStep();
              }
          }
          // Remove parsed part from buffer
          streamBuffer = streamBuffer.substring(match.index + match[1].length);
          actionRegex.lastIndex = 0; 
      } catch (e) {
          // Incomplete JSON, wait for more
      }
  }
}

function saveState() {
  if (currentJob) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(currentJob, null, 2));
  }
}

console.log(`Desktop App (The Brain) started on ws://localhost:${PORT}`);
