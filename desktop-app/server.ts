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
}

let currentJob: JobState | null = null;
let pluginSocket: WebSocket | null = null;

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
  
  // 1. Request canvas data first
  if (pluginSocket) {
    pluginSocket.send(JSON.stringify({ type: 'READ_CANVAS' }));
  }
  
  // We'll wait for CANVAS_DATA message to continue
  currentJob = {
    prompt,
    steps: [],
    currentIndex: 0,
    isRunning: true
  };
  saveState();
}

async function handleCanvasData(canvasData: any) {
  if (!currentJob) return;

  console.log('Received canvas data, calling LongCat API...');
  
  try {
    const response = await axios.post(`${LONGCAT_BASE_URL}/chat/completions`, {
      model: 'longcat-v1', // Placeholder, verify with user or docs
      messages: [
        {
          role: 'system',
          content: 'You are a Figma design assistant. Respond ONLY with a JSON array of actions. Actions: createFrame, addRectangle, addText, etc. Use structure: { "action": "...", "props": { ... } }'
        },
        {
          role: 'user',
          content: `Context: ${JSON.stringify(canvasData)}\n\nPrompt: ${currentJob.prompt}`
        }
      ],
      response_format: { type: 'json_object' }
    }, {
      headers: { 'Authorization': `Bearer ${LONGCAT_API_KEY}` }
    });

    const steps = response.data.choices[0].message.content;
    currentJob.steps = JSON.parse(steps);
    currentJob.currentIndex = 0;
    saveState();

    sendNextStep();
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

function saveState() {
  if (currentJob) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(currentJob, null, 2));
  }
}

console.log(`Desktop App (The Brain) started on ws://localhost:${PORT}`);
