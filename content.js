// NanoAI — Content Script (injected on all pages)
// Provides page text, selected text, metadata, and interactive elements

function getPageText(maxLen = 8000) {
  // Try clean selectors first
  const selectors = ['main', 'article', '[role="main"]', '.content', '#content', '.post-content', '.article-body'];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim().length > 200) {
      return el.innerText.trim().slice(0, maxLen);
    }
  }

  // Fallback: Clone body and clean it
  try {
    const bodyClone = document.body.cloneNode(true);
    const toRemove = bodyClone.querySelectorAll('script, style, nav, footer, iframe, noscript, svg, header, .ad, .sidebar');
    toRemove.forEach(el => el.remove());
    let text = bodyClone.innerText || bodyClone.textContent || '';
    text = text.replace(/\s+/g, ' ').trim();
    return text.slice(0, maxLen);
  } catch (e) {
    return document.body.innerText.trim().slice(0, maxLen);
  }
}

function getSelectedText() {
  return window.getSelection()?.toString()?.trim() || '';
}

function getPageMetadata() {
  return {
    title: document.title,
    url: location.href,
    description: document.querySelector('meta[name="description"]')?.content || '',
    lang: document.documentElement.lang || '',
    charset: document.characterSet
  };
}

// DOM Element Registry for absolute accuracy
window.nanoElementRegistry = new Map();
window.nanoElementIdCounter = 0;

// Get interactive elements for Page Agent
function getPageStructure() {
  const elements = [];
  window.nanoElementRegistry.clear();
  window.nanoElementIdCounter = 0;

  function registerElement(el) {
    const id = window.nanoElementIdCounter++;
    window.nanoElementRegistry.set(id, el);
    return id;
  }

  // Buttons
  document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach((el) => {
    if (el.offsetParent === null) return; // hidden
    const text = el.innerText?.trim() || el.value || el.title || el.getAttribute('aria-label') || '';
    if (text) elements.push({ type: 'button', text: text.slice(0, 60), elementId: registerElement(el) });
  });

  // Links
  document.querySelectorAll('a[href]').forEach((el) => {
    if (el.offsetParent === null) return;
    const text = el.innerText?.trim() || el.title || '';
    if (text && text.length > 1) elements.push({ type: 'link', text: text.slice(0, 60), href: el.href?.slice(0, 100), elementId: registerElement(el) });
  });

  // Form inputs & Rich Text areas
  document.querySelectorAll('input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="textbox"]').forEach((el) => {
    if (el.offsetParent === null) return;
    const isRichText = el.isContentEditable || el.getAttribute('role') === 'textbox';
    elements.push({
      type: 'input',
      inputType: isRichText ? 'richtext' : (el.type || el.tagName.toLowerCase()),
      name: el.name || el.id || '',
      placeholder: el.placeholder || el.getAttribute('data-placeholder') || '',
      label: el.labels?.[0]?.textContent?.trim() || el.getAttribute('aria-label') || '',
      value: el.type === 'password' ? '***' : (isRichText ? el.textContent?.slice(0, 50) : el.value?.slice(0, 50)) || '',
      elementId: registerElement(el)
    });
  });

  return elements.slice(0, 80); // increased limit to 80
}

// Execute an action on the page (click, fill, scroll, etc.)
function executeAction(action) {
  try {
    let el = null;
    if (action.type !== 'scroll') {
      const id = parseInt(action.elementId, 10);
      el = window.nanoElementRegistry.get(id);
      if (!el && action.type !== 'press') {
        return { ok: false, error: `Element ID ${action.elementId} not found in registry.` };
      }
    }

    switch (action.type) {
      case 'click': {
        highlightElement(el);
        el.focus();
        el.click();
        const label = el.innerText?.trim() || el.value || el.getAttribute('aria-label') || el.title || 'Element';
        return { ok: true, message: `Clicked: "${label.slice(0, 40)}"` };
      }
      case 'fill': {
        highlightElement(el);
        el.focus();
        
        const isRichText = el.isContentEditable || el.getAttribute('role') === 'textbox';
        
        if (isRichText) {
          // Handle contenteditable / rich text areas
          el.textContent = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.textContent = action.value;
        } else {
          // Standard inputs
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(el, action.value);
          } else {
            el.value = action.value;
          }
        }
        
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        el.blur();
        
        const labelText = el.labels?.[0]?.textContent?.trim() || el.name || el.placeholder || el.getAttribute('aria-label') || action.selector;
        return { ok: true, message: `Filled "${labelText}" with "${action.value?.slice(0, 30)}"` };
      }
      case 'scroll': {
        const px = parseInt(action.value || action.selector) || 500;
        window.scrollBy({ top: px, behavior: 'smooth' });
        return { ok: true, message: `Scrolled ${px}px` };
      }
      case 'select': {
        highlightElement(el);
        el.value = action.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, message: `Selected "${action.value}"` };
      }
      case 'hover': {
        highlightElement(el);
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        return { ok: true, message: `Hovered over element` };
      }
      case 'press': {
        let key = action.value || action.elementId || 'Enter'; // elementId here holds the key name if no value is passed
        let keyCode = key.toLowerCase() === 'enter' ? 13 : (key.toLowerCase() === 'escape' ? 27 : 0);
        
        // If an element is currently focused, send the event there, otherwise document.body
        const target = document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: key, keyCode: keyCode, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keypress', { key: key, keyCode: keyCode, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key: key, keyCode: keyCode, bubbles: true }));
        
        return { ok: true, message: `Pressed ${key}` };
      }
      default:
        return { ok: false, error: 'Unknown action: ' + action.type };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Visual highlight effect on elements being acted upon
function highlightElement(el) {
  const orig = el.style.outline;
  const origTransition = el.style.transition;
  el.style.transition = 'outline 0.2s ease';
  el.style.outline = '3px solid #6366f1';
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => {
    el.style.outline = orig;
    el.style.transition = origTransition;
  }, 1500);
}

// Get full page context (text + metadata + structure)
function getFullContext(maxLen = 6000) {
  const meta = getPageMetadata();
  const text = getPageText(maxLen);
  const selected = getSelectedText();
  const structure = getPageStructure();

  return { meta, text, selected, structure };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'getPageText':
      sendResponse({ text: getPageText(msg.maxLen || 8000) });
      break;
    case 'getSelectedText':
      sendResponse({ text: getSelectedText() });
      break;
    case 'getPageMetadata':
      sendResponse(getPageMetadata());
      break;
    case 'getPageStructure':
      sendResponse({ elements: getPageStructure() });
      break;
    case 'getFullContext':
      sendResponse(getFullContext(msg.maxLen || 6000));
      break;
    case 'executeAction':
      sendResponse(executeAction(msg.actionData));
      break;
    default:
      sendResponse({ error: 'Unknown action' });
  }
  return true;
});
