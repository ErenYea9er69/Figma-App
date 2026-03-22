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
  tokens?: any;
  history: any[];
  isCritique?: boolean;
  vibe?: string;
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
        handleRunPrompt(message.prompt, message.vibe);
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
      case 'TOKENS':
        handleTokens(message.data);
        break;
      case 'STEP_ERROR':
        handleStepError(message.error, message.step);
        break;
    }
  });

  ws.on('close', () => {
    console.log('Figma Plugin disconnected');
    pluginSocket = null;
    saveState();
  });
});

async function handleRunPrompt(prompt: string, vibe: string = 'default') {
  console.log('Running prompt:', prompt, 'with vibe:', vibe);
  
  // 1. Request canvas data, image data, AND components
  if (pluginSocket) {
    pluginSocket.send(JSON.stringify({ type: 'READ_CANVAS' }));
    pluginSocket.send(JSON.stringify({ type: 'READ_IMAGE' }));
    pluginSocket.send(JSON.stringify({ type: 'READ_COMPONENTS' }));
    pluginSocket.send(JSON.stringify({ type: 'READ_TOKENS' }));
  }
  
  currentJob = {
    prompt,
    steps: currentJob?.isRunning ? currentJob.steps : [], // Keep steps if refining
    currentIndex: currentJob?.isRunning ? currentJob.currentIndex : 0,
    isRunning: true,
    canvasImage: undefined,
    components: undefined,
    tokens: undefined,
    history: currentJob?.history || [],
    isCritique: false,
    vibe: vibe
  };
  
  // Add user prompt to history
  currentJob.history.push({ role: 'user', content: prompt });
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

async function handleTokens(tokens: any) {
  if (!currentJob) return;
  console.log('Received design tokens data');
  currentJob.tokens = tokens;
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
  if (!currentJob || !currentJob.isRunning || !currentJob.canvasData || 
      currentJob.components === undefined || currentJob.tokens === undefined) return;
  
  if (currentJob.canvasImage === undefined) return;

  console.log('All data ready, calling LongCat API...');
  
  try {
    const vibeRules: Record<string, string> = {
      minimalist: "Use LOTS of white space, large margins, rounded corners (16px+), and subtle subtle grays.",
      brutalist: "Use bold black borders (2px), sharp corners (0px), high contrast colors (Neon), and heavy shadows.",
      glassmorphism: "Use transparent fills with background blur, white 1px borders, and vibrant gradient backgrounds.",
      enterprise: "Use compact spacing, 4px corners, muted professional colors, and high information density.",
      default: "Use modern clean design standards."
    };

    const messages: any[] = [
      {
        role: 'system',
        content: `You are a world-class Figma design architect. 
        Your goal is to build professional, high-fidelity landing pages or UI components.
        
        VISUAL STYLE GUIDE: 
        ${vibeRules[currentJob.vibe || 'default']}
        
        CRITICAL RULES:
        1. Respond ONLY with a JSON array of actions.
        2. ALWAYS use Auto-Layout for frames (layoutMode: 'HORIZONTAL' | 'VERTICAL').
        3. Use appropriate spacing (itemSpacing) and padding.
        4. Colors should be modern (hex codes).
        5. Structure your actions logically (Frames first, then children).
        6. For RESPONSIVE designs: 
           - Use layoutAlign: 'STRETCH' to fill the parent width/height.
           - Use layoutGrow: 1 to occupy remaining space in the layout axis.
        
        SUPPORTED ACTIONS:
        - createFrame: { name, width, height, fill, layoutMode, itemSpacing, paddingLeft, paddingRight, paddingTop, paddingBottom, primaryAxisAlignItems, counterAxisAlignItems, layoutAlign, layoutGrow }
        - addText: { content, fontSize, fill, x, y }
        - addInstance: { componentId, x, y, name, variables, isRemote, properties } // properties: { "PropName": "Value" } for Variants
        - addPrototypeConnection: { sourceNodeId, destinationNodeId, triggerType, actionType }
        - fetchDataAndPopulate: { url, mapping } // mapping: { "textNodeName": "jsonPath" }
        - displayCode: { language, code } // For React/Tailwind handover
        - createPage: { name }
        
        AVAILABLE COMPONENTS:
        ${JSON.stringify(currentJob.components)}
        
        AVAILABLE TOKENS (STYLES & VARIABLES):
        ${JSON.stringify(currentJob.tokens)}
        
        PRIORITY: 
        1. Use existing COMPONENTS if they match the UI need.
        2. Use TOKENS (fillStyleId, textStyleId) instead of raw hex codes.
        `
      }
    ];

    // Include history (limited to last 10 messages for context)
    if (currentJob.history.length > 1) {
      messages.push(...currentJob.history.slice(-10, -1));
    }

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
      if (!currentJob?.isCritique) {
        handleCritiquePhase();
      }
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

async function handleStepError(error: string, step: any) {
  if (!currentJob) return;
  console.error(`Step error reported: ${error}`, step);
  
  // 1. Add error to history
  currentJob.history.push({ 
    role: 'assistant', 
    content: `I'll execute this action: ${JSON.stringify(step)}` 
  });
  currentJob.history.push({ 
    role: 'user', // System-level feedback mask as user or system role if supported
    content: `The previous step failed with error: "${error}". Please analyze why it failed and provide a corrected sequence of actions to achieve the goal.` 
  });

  // 2. Stop current execution and clear remaining steps
  currentJob.steps = [];
  currentJob.currentIndex = 0;
  streamBuffer = ''; // Clear buffer for fresh AI response
  
  saveState();
  
  // 3. Re-trigger AI for correction
  checkReadyAndCallAI();
}

async function handleCritiquePhase() {
  if (!currentJob) return;
  console.log('Starting Critique Phase...');
  
  currentJob.isCritique = true;
  currentJob.history.push({
    role: 'user',
    content: "Design complete. Now, perform a professional critique and WCAG 2.1 Accessibility Audit of the design you just built. \n\nCHECKLIST:\n1. Contrast: Ensure text has a 4.5:1 ratio against background.\n2. Hierarchy: Are heading sizes logical (H1, H2, H3)?\n3. Naming: Are layers named semantically for developers?\n4. Spacing: 8pt grid consistency.\n\nIf you find ANY issues, provide actions to FIX them. If everything is perfect, say 'CRITIQUE_AND_ACCESSIBILITY_COMPLETE'."
  });
  
  saveState();
  
  // We need to refresh canvas data for the critique
  if (pluginSocket) {
    pluginSocket.send(JSON.stringify({ type: 'READ_CANVAS' }));
    pluginSocket.send(JSON.stringify({ type: 'READ_IMAGE' }));
  }
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
