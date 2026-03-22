/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 320, height: 480, themeColors: true });

figma.ui.onmessage = async (msg: any) => {
  if (msg.type === 'GET_CANVAS_DATA') {
    const data = serializeCanvas();
    figma.ui.postMessage({ type: 'CANVAS_DATA_RESULT', data });
  } else if (msg.type === 'GET_IMAGE_DATA') {
    const data = await serializeSelectionAsImage();
    figma.ui.postMessage({ type: 'CANVAS_IMAGE_RESULT', data });
  } else if (msg.type === 'GET_COMPONENTS') {
    const data = serializeComponents();
    figma.ui.postMessage({ type: 'COMPONENTS_RESULT', data });
  } else if (msg.type === 'RUN_STEP') {
    await executeStep(msg.step);
    figma.ui.postMessage({ type: 'STEP_DONE' });
  }
};

function serializeCanvas() {
  // Simple summary of top-level frames
  const frames = figma.currentPage.children
    .filter((node): node is FrameNode => node.type === 'FRAME')
    .map(node => ({
      name: node.name,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      childrenCount: node.children.length
    }));
  
  return {
    selection: figma.currentPage.selection.map((n: SceneNode) => ({ type: n.type, name: n.name })),
    frames: frames
  };
}

async function serializeSelectionAsImage() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) return null;

  try {
    // Export the selection as a PNG
    const bytes = await selection[0].exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: 2 }
    });
    
    // Convert to base64 for transmission
    // Using a simple trick for base64 in plugin environment
    return figma.base64Encode(bytes);
  } catch (e) {
    console.error('Export failed:', e);
    return null;
  }
}

function serializeComponents() {
  // Find all local components
  return figma.currentPage.findAll(n => n.type === 'COMPONENT')
    .map(n => ({
      id: n.id,
      name: n.name,
      description: (n as ComponentNode).description
    }));
}

async function executeStep(step: any) {
  const { action, props } = step;

  switch (action) {
    case 'createFrame':
      const frame = figma.createFrame();
      frame.name = props.name || 'New Frame';
      frame.resize(props.width || 400, props.height || 400);
      frame.x = props.x || 0;
      frame.y = props.y || 0;
      if (props.fill) {
        frame.fills = [{ type: 'SOLID', color: hexToRgb(props.fill) }];
      }

      // Auto-Layout Support
      if (props.layoutMode) {
        frame.layoutMode = props.layoutMode; // 'HORIZONTAL' | 'VERTICAL'
        if (props.itemSpacing !== undefined) frame.itemSpacing = props.itemSpacing;
        if (props.paddingLeft !== undefined) frame.paddingLeft = props.paddingLeft;
        if (props.paddingRight !== undefined) frame.paddingRight = props.paddingRight;
        if (props.paddingTop !== undefined) frame.paddingTop = props.paddingTop;
        if (props.paddingBottom !== undefined) frame.paddingBottom = props.paddingBottom;
        if (props.primaryAxisAlignItems) frame.primaryAxisAlignItems = props.primaryAxisAlignItems;
        if (props.counterAxisAlignItems) frame.counterAxisAlignItems = props.counterAxisAlignItems;
      }

      figma.viewport.scrollAndZoomIntoView([frame]);
      break;

    case 'addRectangle':
      const rect = figma.createRectangle();
      rect.name = props.name || 'Rectangle';
      rect.resize(props.width || 100, props.height || 100);
      rect.x = props.x || 0;
      rect.y = props.y || 0;
      if (props.fill) {
        rect.fills = [{ type: 'SOLID', color: hexToRgb(props.fill) }];
      }
      if (props.cornerRadius) rect.cornerRadius = props.cornerRadius;
      
      // Add to parent if specified (simplified)
      const parent = (figma.currentPage.selection[0] as FrameNode) || figma.currentPage;
      if ('appendChild' in parent) {
        (parent as any).appendChild(rect);
      }
      break;

    case 'addText':
      await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      const text = figma.createText();
      text.characters = props.content || 'Text';
      text.x = props.x || 0;
      text.y = props.y || 0;
      text.fontSize = props.fontSize || 14;
      if (props.fill) {
        text.fills = [{ type: 'SOLID', color: hexToRgb(props.fill) }];
      }
      break;

    case 'addInstance':
      const component = figma.getNodeById(props.componentId) as ComponentNode;
      if (component) {
        const instance = component.createInstance();
        instance.x = props.x || 0;
        instance.y = props.y || 0;
        if (props.name) instance.name = props.name;
        
        const instParent = (figma.currentPage.selection[0] as FrameNode) || figma.currentPage;
        if ('appendChild' in instParent) {
          (instParent as any).appendChild(instance);
        }
      }
      break;
    
    // Add more actions as needed...
  }
}

function hexToRgb(hex: string) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  };
}
