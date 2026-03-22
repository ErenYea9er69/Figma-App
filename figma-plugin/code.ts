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
    const local = serializeComponents();
    const library = await serializeLibraryComponents();
    figma.ui.postMessage({ type: 'COMPONENTS_RESULT', data: [...local, ...library] });
  } else if (msg.type === 'GET_TOKENS') {
    const data = serializeTokens();
    figma.ui.postMessage({ type: 'TOKENS_RESULT', data });
  } else if (msg.type === 'RUN_STEP') {
    try {
      await executeStep(msg.step);
      figma.ui.postMessage({ type: 'STEP_DONE' });
    } catch (error: any) {
      figma.ui.postMessage({ type: 'STEP_ERROR', error: error.message, step: msg.step });
    }
  }
};

function serializeCanvas() {
  const selection = figma.currentPage.selection;
  const viewport = figma.viewport.bounds;
  
  // Logic: 
  // 1. If nodes are selected, prioritize those.
  // 2. Otherwise, only take top-level nodes that are within the current viewport.
  
  let rootNodes: readonly SceneNode[] = [];
  
  if (selection.length > 0) {
    rootNodes = selection;
  } else {
    rootNodes = figma.currentPage.children.filter(node => {
      // Check if node overlaps with viewport bounds
      return (
        node.x < viewport.x + viewport.width &&
        node.x + node.width > viewport.x &&
        node.y < viewport.y + viewport.height &&
        node.y + node.height > viewport.y
      );
    });
  }
  
  const MAX_DEPTH = 3;
  const walk = (node: SceneNode, depth: number): any => {
    if (depth > MAX_DEPTH) return { type: node.type, name: node.name, id: node.id, note: 'Max depth reached' };
    
    const data: any = {
      id: node.id,
      type: node.type,
      name: node.name,
      x: Math.round(node.x),
      y: Math.round(node.y),
      width: Math.round(node.width),
      height: Math.round(node.height)
    };

    if ('children' in node) {
      data.children = (node as any).children.map((c: SceneNode) => walk(c, depth + 1));
    }

    return data;
  };

  return {
    selection: selection.map(n => ({ type: n.type, name: n.name, id: n.id })),
    tree: rootNodes.slice(0, 50).map(n => walk(n, 0)), // Cap at 50 root nodes for safety
    viewport: { x: Math.round(viewport.x), y: Math.round(viewport.y), width: Math.round(viewport.width), height: Math.round(viewport.height) }
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
      description: (n as ComponentNode).description,
      isRemote: false
    }));
}

async function serializeLibraryComponents() {
  try {
    const libraries = await (figma.teamLibrary as any).getAvailableLibraryComponentsAsync();
    // Only take the first 50 to avoid overloading the AI
    return libraries.slice(0, 50).map((c: any) => ({
      id: c.key, // Remote components use keys for instantiation
      name: c.name,
      description: c.description,
      isRemote: true
    }));
  } catch (e) {
    console.warn('Library access failed:', e);
    return [];
  }
}

function serializeTokens() {
  const paintStyles = figma.getLocalPaintStyles().map(s => ({ id: s.id, name: s.name, type: s.type }));
  const textStyles = figma.getLocalTextStyles().map(s => ({ id: s.id, name: s.name }));
  
  // Variables require a bit more care
  const variables = figma.variables.getLocalVariables().map(v => ({
    id: v.id,
    name: v.name,
    resolvedType: v.resolvedType
  }));

  return { paintStyles, textStyles, variables };
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
      
      if (props.fillStyleId) {
        frame.fillStyleId = props.fillStyleId;
      } else if (props.fill) {
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
      
      // Responsive Sizing
      if (props.layoutAlign) frame.layoutAlign = props.layoutAlign; // 'STRETCH' | 'INHERIT'
      if (props.layoutGrow !== undefined) frame.layoutGrow = props.layoutGrow; // 0 | 1
      if (props.layoutPositioning) (frame as any).layoutPositioning = props.layoutPositioning; // 'ABSOLUTE' | 'AUTO'

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
      
      // Responsive Sizing
      if (props.layoutAlign) rect.layoutAlign = props.layoutAlign;
      if (props.layoutGrow !== undefined) rect.layoutGrow = props.layoutGrow;
      if (props.layoutPositioning) (rect as any).layoutPositioning = props.layoutPositioning;

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
      let component: ComponentNode | null = null;
      if (props.isRemote) {
        component = (await figma.importComponentByKeyAsync(props.componentId)) as any;
      } else {
        component = figma.getNodeById(props.componentId) as ComponentNode;
      }

      if (component) {
        const instance = (component as any).createInstance();
        instance.x = props.x || 0;
        instance.y = props.y || 0;
        if (props.name) instance.name = props.name;
        
        // Apply Variants / Properties
        if (props.properties && 'setProperties' in instance) {
          (instance as any).setProperties(props.properties);
        }
        
        // Apply variables if specified
        if (props.variables) {
           for (const [prop, varId] of Object.entries(props.variables)) {
             const variable = figma.variables.getVariableById(varId as string);
             if (variable) {
               // This is a simplified application
               (instance as any).setBoundVariable(prop, variable.id);
             }
           }
        }
        
        const instParent = (figma.currentPage.selection[0] as FrameNode) || figma.currentPage;
        if ('appendChild' in instParent) {
          (instParent as any).appendChild(instance);
        }
      }
      break;

    case 'addPrototypeConnection':
      const source = figma.getNodeById(props.sourceNodeId) as SceneNode;
      const destination = figma.getNodeById(props.destinationNodeId) as SceneNode;
      
      if (source && destination && 'reactions' in source) {
        (source as any).reactions = [
          {
            trigger: { type: props.triggerType || 'ON_CLICK' },
            actions: [{ 
              type: props.actionType || 'NAVIGATE', 
              destinationId: destination.id,
              navigationType: 'NAVIGATE',
              transition: props.transitionType === 'SMART_ANIMATE' ? {
                type: 'SMART_ANIMATE',
                easing: { type: props.easing || 'EASE_IN_OUT' },
                duration: props.duration || 300
              } : null
            }]
          }
        ];
      }
      break;

    case 'fetchDataAndPopulate':
      try {
        const response = await fetch(props.url);
        const data = await response.json();
        
        // Find nodes by name and update content
        for (const [nodeName, path] of Object.entries(props.mapping)) {
           const val = getValueByPath(data, path as string);
           const nodes = figma.currentPage.findAll(n => n.name === nodeName && n.type === 'TEXT');
           for (const node of nodes) {
              await figma.loadFontAsync((node as TextNode).fontName as FontName);
              (node as TextNode).characters = String(val);
           }
        }
      } catch (e) {
        console.error('Fetch failed:', e);
      }
      break;

    case 'createPage':
      const newPage = figma.createPage();
      newPage.name = props.name || 'New Page';
      figma.currentPage = newPage;
      break;

    case 'setVariableMode':
      const nodes = figma.currentPage.selection;
      if (nodes.length > 0) {
        for (const node of nodes) {
          if ('setExplicitVariableModeForCollection' in node) {
            (node as any).setExplicitVariableModeForCollection(props.collectionId, props.modeId);
          }
        }
      }
      break;

    case 'addHeatmapOverlay':
      const overlay = figma.createFrame();
      overlay.name = 'UX_Heatmap_Overlay';
      overlay.backgrounds = [];
      overlay.fills = [];
      overlay.x = props.x || 0;
      overlay.y = props.y || 0;
      overlay.resize(props.width || 1000, props.height || 1000);
      overlay.locked = true;
      overlay.opacity = 0.6;
      
      for (const point of props.points) {
        const circle = figma.createEllipse();
        circle.resize(point.radius * 2, point.radius * 2);
        circle.x = point.x - point.radius;
        circle.y = point.y - point.radius;
        circle.fills = [{ type: 'SOLID', color: { r: 1, g: 0.2, b: 0.2 } }];
        circle.effects = [{ 
          type: 'LAYER_BLUR', 
          radius: point.radius, 
          visible: true 
        } as BlurEffect];
        overlay.appendChild(circle);
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

function getValueByPath(obj: any, path: string) {
  return path.split('.').reduce((o, i) => (o ? o[i] : undefined), obj);
}
