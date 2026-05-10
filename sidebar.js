// ═══════════════════════════════════════════════════════════
// NanoAI Assistant — Sidebar Core Logic
// ═══════════════════════════════════════════════════════════

// ─── Constants ────────────────────────────────────────────
const STORAGE_KEY = 'nanoai_conversations';
const ACTIVE_KEY = 'nanoai_active_id';
const BASE_PROMPT = `You are NanoAI, a helpful AI assistant. 
Rules:
- Respond in the same language the user writes in.
- Be concise, friendly, and helpful.
- Use markdown for formatting (**bold**, *italic*, lists).
- If page context is provided, use it to answer questions about the current website.`;

const AGENT_PROMPT = `You are an autonomous web agent. To achieve complex goals, you must take ONE logical step at a time.
After your action, the system will execute it and return the NEW page state.

You must use this exact format for every response:
THOUGHT: [Analyze current state]
REPLY: [Conversational answer to user]
ACTION: [ONE command or <<ACTION:done>>]

Available Commands: click|ID, fill|ID|VAL, scroll|top|PX, hover|ID, press|KEY, done.

EXAMPLES:
- User: "Translate this story to Bengali"
  THOUGHT: The user wants a translation. I have the story text in "PAGE CONTENT". I will translate it now and finish.
  REPLY: [Bengali translation of the text...]
  ACTION: <<ACTION:done>>

- User: "Like the first post"
  THOUGHT: I need to find the Like button for the first post. It is ID 5.
  REPLY: I am clicking the like button for you.
  ACTION: <<ACTION:click|5>>

CRITICAL RULES:
1. ONLY take actions if the user wants to PERFORM a task (click, type, search).
2. If the user wants INFORMATION (Translate, Summarize, What is this?), use the REPLY block to answer using "PAGE CONTENT" and output <<ACTION:done>>.
3. DO NOT click, scroll or search if the answer is already visible on the page.
4. ABSOLUTE: If ACTION is not "done", the next turn will refresh the DOM. Use "done" as soon as the user's request is satisfied.
5. Only use IDs from "INTERACTIVE ELEMENTS".`;

// ─── State ────────────────────────────────────────────────
let conversations = [];
let activeConvId = null;
let isProcessing = false;
let isAgentMode = false;
let cachedPageContext = null;
let lastContextTabId = null;

// Agent Loop State
let agentLoopActive = false;
let agentHistory = [];
let currentGoal = '';

// ─── DOM refs ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const chatArea = $('chat-area');
const messagesEl = $('messages');
const welcomeEl = $('welcome-screen');
const inputEl = $('input');
const sendBtn = $('send-btn');
const statusDot = $('status-dot');
const statusText = $('status-text');
const convOverlay = $('conv-overlay');
const convList = $('conv-list');
const agentToggle = $('agent-toggle');
const agentStatusBar = $('agent-status-bar');
const agentStatusText = $('agent-status-text');
const stopAgentBtn = $('stop-agent-btn');

// ─── LanguageModel Detection ──────────────────────────────
function getLanguageModel() {
  if (typeof LanguageModel !== 'undefined') return LanguageModel;
  if (typeof self !== 'undefined' && self.ai?.languageModel) return self.ai.languageModel;
  if (typeof window !== 'undefined' && window.ai?.languageModel) return window.ai.languageModel;
  return null;
}

// ─── Storage ──────────────────────────────────────────────
async function loadConversations() {
  return new Promise(resolve => {
    chrome.storage.local.get([STORAGE_KEY, ACTIVE_KEY], result => {
      conversations = result[STORAGE_KEY] || [];
      activeConvId = result[ACTIVE_KEY] || null;
      resolve();
    });
  });
}

function saveConversations() {
  chrome.storage.local.set({
    [STORAGE_KEY]: conversations,
    [ACTIVE_KEY]: activeConvId
  });
}

// ─── Conversation CRUD ───────────────────────────────────
function createConversation(switchTo = true) {
  const conv = {
    id: 'conv_' + Date.now(),
    title: 'New Chat',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  conversations.unshift(conv);
  if (switchTo) {
    activeConvId = conv.id;
    renderAll();
  }
  saveConversations();
  return conv;
}

function getActiveConversation() {
  return conversations.find(c => c.id === activeConvId) || null;
}

function deleteConversation(id) {
  conversations = conversations.filter(c => c.id !== id);
  if (activeConvId === id) {
    activeConvId = conversations[0]?.id || null;
    if (!activeConvId) createConversation();
  }
  renderAll();
  saveConversations();
}

function switchConversation(id) {
  activeConvId = id;
  renderAll();
  saveConversations();
}

// ─── Simple Markdown Renderer ────────────────────────────
function renderMarkdown(text) {
  let h = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.trim()}</code></pre>`);

  // Inline code
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  h = h.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

  // Unordered lists
  h = h.replace(/^[-*]\s+(.+)/gm, '<li>$1</li>');

  // Ordered lists
  h = h.replace(/^\d+\.\s+(.+)/gm, '<li>$1</li>');

  // Wrap consecutive <li> in <ul>
  h = h.replace(/((?:<li>.*<\/li>\s*)+)/g, '<ul>$1</ul>');

  // Line breaks (but not inside pre)
  const parts = h.split(/(<pre>[\s\S]*?<\/pre>)/g);
  h = parts.map((p, i) => i % 2 === 0 ? p.replace(/\n/g, '<br>') : p).join('');

  return h;
}

// ─── UI Rendering ─────────────────────────────────────────
function renderAll() {
  renderMessages();
  renderConversationList();
}

function renderMessages() {
  const conv = getActiveConversation();
  messagesEl.innerHTML = '';

  if (!conv || conv.messages.length === 0) {
    welcomeEl.style.display = 'flex';
    return;
  }

  welcomeEl.style.display = 'none';

  conv.messages.forEach(msg => {
    const div = document.createElement('div');
    div.className = `msg msg-${msg.role}`;
    if (msg.role === 'ai') {
      div.innerHTML = renderMarkdown(msg.content);
    } else {
      div.textContent = msg.content;
    }
    messagesEl.appendChild(div);
  });

  scrollToBottom();
}

function renderConversationList() {
  convList.innerHTML = '';

  if (conversations.length === 0) {
    convList.innerHTML = '<div class="conv-empty">No conversations yet</div>';
    return;
  }

  // Group by date
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();

  conversations.forEach(conv => {
    const item = document.createElement('div');
    item.className = 'conv-item' + (conv.id === activeConvId ? ' active' : '');
    item.innerHTML = `
      <div class="conv-item-content">
        <div class="conv-item-title">${escapeHtml(conv.title)}</div>
        <div class="conv-item-time">${formatTime(conv.updatedAt)}</div>
      </div>
      <button class="conv-item-delete" title="Delete"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
    `;

    item.querySelector('.conv-item-content').addEventListener('click', () => {
      switchConversation(conv.id);
      toggleConvPanel(false);
    });

    item.querySelector('.conv-item-delete').addEventListener('click', e => {
      e.stopPropagation();
      deleteConversation(conv.id);
    });

    convList.appendChild(item);
  });
}

function escapeHtml(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTime(ts) {
  const d = new Date(ts);
  const today = new Date().toDateString();
  if (d.toDateString() === today) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    chatArea.scrollTop = chatArea.scrollHeight;
  });
}

function appendMessageEl(role, content, useMarkdown = false) {
  welcomeEl.style.display = 'none';
  const div = document.createElement('div');
  div.className = `msg msg-${role}`;
  if (useMarkdown) {
    div.innerHTML = renderMarkdown(content);
  } else {
    div.textContent = content;
  }
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function showTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.id = 'typing';
  div.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
  messagesEl.appendChild(div);
  scrollToBottom();
}

function removeTypingIndicator() {
  const el = $('typing');
  if (el) el.remove();
}

// ─── Conversation Panel ──────────────────────────────────
function toggleConvPanel(show) {
  if (show === undefined) show = convOverlay.classList.contains('hidden');
  if (show) {
    renderConversationList();
    convOverlay.classList.remove('hidden');
  } else {
    convOverlay.classList.add('hidden');
  }
}

// ─── Page Context ─────────────────────────────────────────
async function getPageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')) {
      return null;
    }

    // Try getting full context from content script
    let ctx = await new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, { action: 'getFullContext', maxLen: 5000 }, r => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(r);
      });
    });

    // If content script not ready, inject and retry
    if (!ctx) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        ctx = await new Promise(resolve => {
          chrome.tabs.sendMessage(tab.id, { action: 'getFullContext', maxLen: 5000 }, r => {
            if (chrome.runtime.lastError) resolve(null);
            else resolve(r);
          });
        });
      } catch { /* ignore */ }
    }

    if (ctx) {
      cachedPageContext = ctx;
      lastContextTabId = tab.id;
    }
    return ctx;
  } catch {
    return null;
  }
}

function buildContextPrompt(ctx) {
  if (!ctx) return '';
  let prompt = '\n\n--- CURRENT PAGE CONTEXT ---';
  if (ctx.meta) prompt += `\nTitle: ${ctx.meta.title}\nURL: ${ctx.meta.url}`;
  if (ctx.selected) prompt += `\n\nUSER SELECTED TEXT:\n${ctx.selected}`;
  if (ctx.text) prompt += `\n\nPAGE CONTENT:\n${ctx.text.slice(0, 4000)}`;
  prompt += '\n--- END CONTEXT ---';
  return prompt;
}

function buildAgentPrompt(ctx) {
  if (!ctx) return '';
  let prompt = '\n\n--- PAGE STRUCTURE ---';
  if (ctx.meta) prompt += `\nTitle: ${ctx.meta.title}\nURL: ${ctx.meta.url}`;
  if (ctx.structure && ctx.structure.length > 0) {
    prompt += '\n\nINTERACTIVE ELEMENTS:';
    ctx.structure.forEach((el, i) => {
      if (el.type === 'button') prompt += `\n  ID: ${el.elementId} | TYPE: button | TEXT: "${el.text}"`;
      else if (el.type === 'link') prompt += `\n  ID: ${el.elementId} | TYPE: link | TEXT: "${el.text}"`;
      else if (el.type === 'input') prompt += `\n  ID: ${el.elementId} | TYPE: input | LABEL/PLACEHOLDER: "${el.label || el.placeholder || el.name}"`;
    });
  }
  if (ctx.text) prompt += `\n\nPAGE CONTENT (summary):\n${ctx.text.slice(0, 2000)}`;
  prompt += '\n--- END STRUCTURE ---';
  return prompt;
}

async function classifyIntent(text) {
  const lm = getLanguageModel();
  if (!lm) return 'INFO';
  
  // Quick heuristic for obvious info requests to save time
  const lowerText = text.toLowerCase();
  const infoWords = ['translate', 'summarize', 'what', 'who', 'tell', 'read', 'অনুবাদ', 'সারসংক্ষেপ'];
  if (infoWords.some(w => lowerText.includes(w)) && !lowerText.includes('click') && !lowerText.includes('search')) {
    return 'INFO';
  }

  try {
    const session = await lm.create({
      systemPrompt: "Classify user intent as 'AUTO' (if they want a physical action like click/fill/search) or 'INFO' (if they want information, translation, summary, or chat). Reply ONLY with 'AUTO' or 'INFO'."
    });
    const result = await session.prompt(text);
    return result.trim().toUpperCase().includes('AUTO') ? 'AUTO' : 'INFO';
  } catch (e) {
    return 'INFO';
  }
}

// ─── Send Message ─────────────────────────────────────────
async function sendMessage(text, skipContext = false, isAutoAgentPrompt = false) {
  if (isProcessing && !isAutoAgentPrompt) return;
  if (!text.trim() && !isAutoAgentPrompt) return;
  
  isProcessing = true;
  sendBtn.disabled = true;

  // Ensure active conversation
  let conv = getActiveConversation();
  if (!conv) conv = createConversation();

  let intent = 'INFO';
  if (!isAutoAgentPrompt) {
    // User triggered
    conv.messages.push({ role: 'user', content: text.trim(), timestamp: Date.now() });
    conv.updatedAt = Date.now();
    saveConversations();
    appendMessageEl('user', text.trim());

    // 1. Intent Classification (The Router)
    if (isAgentMode) {
      showTypingIndicator(); // Show while classifying
      intent = await classifyIntent(text);
    }

    if (isAgentMode && intent === 'AUTO') {
      agentLoopActive = true;
      agentHistory = [];
      currentGoal = text.trim();
      agentStatusBar.classList.remove('hidden');
    } else {
      agentLoopActive = false;
      agentStatusBar.classList.add('hidden');
    }
  }

  // Show typing indicator
  showTypingIndicator();

  // Auto-fetch page context
  let pageCtx = null;
  // Fetch context if agent mode is ON OR if intent/text needs it
  const needsContext = isAgentMode || text.toLowerCase().includes('page') || text.toLowerCase().includes('site') || text.toLowerCase().includes('summarize');
  
  if (!skipContext && needsContext) {
    if (agentLoopActive) agentStatusText.textContent = "Scanning page...";
    pageCtx = await getPageContext();
  }

  // Build full system prompt
  // If intent is INFO, use BASE_PROMPT even if isAgentMode is on
  const effectiveAgentMode = isAgentMode && intent === 'AUTO';
  let fullSystemPrompt = effectiveAgentMode ? (BASE_PROMPT + "\n\n" + AGENT_PROMPT) : BASE_PROMPT;
  
  if (pageCtx) {
    fullSystemPrompt += effectiveAgentMode ? buildAgentPrompt(pageCtx) : buildContextPrompt(pageCtx);
  }
  
  // Build Model Prompt
  let modelPromptText = text.trim();
  if (agentLoopActive) {
    let historyText = agentHistory.length ? agentHistory.map((h, i) => `${i+1}. ${h}`).join('\n') : 'No actions taken yet.';
    modelPromptText = `GOAL: ${currentGoal}\n\nACTION HISTORY:\n${historyText}\n\nAnalyze the current page structure. What is your next step? Output THOUGHT and ACTION.`;
    agentStatusText.textContent = "Agent is thinking...";
  }
  
  const lm = getLanguageModel();
  if (!lm) {
    removeTypingIndicator();
    appendMessageEl('err', '❌ LanguageModel API not found.');
    isProcessing = false;
    sendBtn.disabled = false;
    if (agentLoopActive) { agentLoopActive = false; agentStatusBar.classList.add('hidden'); }
    return;
  }

  try {
    let session;
    try {
      session = await lm.create({
        initialPrompts: [{ role: 'system', content: fullSystemPrompt }]
      });
    } catch {
      session = await lm.create({ systemPrompt: fullSystemPrompt });
    }

    // Try streaming first
    let fullResponse = '';
    let aiMsgEl;

    try {
      const stream = session.promptStreaming(modelPromptText);
      removeTypingIndicator();
      aiMsgEl = appendMessageEl('ai', '');

      function addChunk(chunk) {
        const val = typeof chunk === 'string' ? chunk : String(chunk);
        if (val.startsWith(fullResponse)) fullResponse = val;
        else fullResponse += val;
        aiMsgEl.innerHTML = renderMarkdown(fullResponse);
        scrollToBottom();
      }

      if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
        for await (const chunk of stream) { addChunk(chunk); }
      } else if (stream && typeof stream.getReader === 'function') {
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          addChunk(value);
        }
      } else {
        throw new Error('Unknown stream type');
      }

      if (!fullResponse.trim()) throw new Error('Empty streaming response');
    } catch (streamErr) {
      console.log('Streaming fallback:', streamErr.message);
      removeTypingIndicator();
      if (aiMsgEl) aiMsgEl.remove();
      fullResponse = await session.prompt(modelPromptText);
      aiMsgEl = appendMessageEl('ai', fullResponse, true);
    }

    session.destroy();

    // Save AI response
    conv.messages.push({ role: 'ai', content: fullResponse, timestamp: Date.now() });
    conv.updatedAt = Date.now();
    saveConversations();

    // Execute any actions found in AI response (Only in Agent Mode)
    let hasDone = false;
    if (isAgentMode) {
      const actions = parseActions(fullResponse);
      hasDone = actions.some(a => a.type === 'done');
      
      if (actions.length > 0) {
        if (agentLoopActive) agentStatusText.textContent = "Executing action...";
        const validActions = actions.filter(a => a.type !== 'done');
        if (validActions.length > 0) {
          const results = await executePageActions(validActions);
          
          const resultLines = results.map(r => {
            let resMsg = r.result?.ok ? `Success (${r.result.message})` : `Failed (${r.result?.error || 'error'})`;
            if (agentLoopActive) agentHistory.push(`Action [${r.type} ${r.elementId || ''}] -> ${resMsg}`);
            return r.result?.ok ? `✅ ${r.type}: ${r.result.message}` : `❌ ${r.type}: ${r.result?.error || 'failed'}`;
          }).join('\n');
          
          if (resultLines) {
            appendMessageEl('system', '⚡ ' + resultLines);
            conv.messages.push({ role: 'system', content: resultLines, timestamp: Date.now() });
            saveConversations();
          }
        } else if (agentLoopActive && !hasDone) {
           agentHistory.push(`Action [none] -> Failed (No valid action found in output)`);
        }
      } else if (agentLoopActive) {
         agentHistory.push(`Action [none] -> Failed (No ACTION command found)`);
      }
    }

    // Auto-title after first exchange
    if (conv.title === 'New Chat' && conv.messages.length >= 2 && !isAutoAgentPrompt) {
      autoTitleConversation(conv);
    }

  } catch (e) {
    removeTypingIndicator();
    appendMessageEl('err', '❌ ' + e.message);
    if (agentLoopActive) agentHistory.push(`Error: ${e.message}`);
  }

  isProcessing = false;
  sendBtn.disabled = false;
  
  // ReAct Loop Continuance
  if (agentLoopActive) {
    if (hasDone || agentHistory.length >= 8) { // Max 8 steps
      agentLoopActive = false;
      agentStatusBar.classList.add('hidden');
      appendMessageEl('system', hasDone ? '🏁 Goal completed.' : '🛑 Agent stopped (Max steps reached).');
    } else {
      agentStatusText.textContent = "Waiting for DOM update...";
      setTimeout(() => {
        if (agentLoopActive) sendMessage('', false, true);
      }, 1500);
    }
  }
}

// ─── Action Parser & Executor ─────────────────────────────
function parseActions(text) {
  const regex = /<<ACTION:(click|fill|select|scroll|hover|press|done)(?:\|([^|>]+?))?(?:\|([^>]*?))?\s*>>/gi;
  const actions = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    actions.push({
      type: match[1].toLowerCase().trim(),
      elementId: match[2]?.trim() || '',
      value: match[3]?.trim() || ''
    });
  }
  return actions;
}

async function executePageActions(actions) {
  const results = [];
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return [{ type: 'error', result: { ok: false, error: 'No active tab' } }];

    for (const action of actions) {
      // Small delay between actions for stability
      if (results.length > 0) await new Promise(r => setTimeout(r, 300));

      const result = await new Promise(resolve => {
        chrome.tabs.sendMessage(tab.id, { action: 'executeAction', actionData: action }, r => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(r || { ok: false, error: 'No response' });
        });
      });
      results.push({ ...action, result });
    }
  } catch (e) {
    results.push({ type: 'error', result: { ok: false, error: e.message } });
  }
  return results;
}

// ─── Auto-title ───────────────────────────────────────────
async function autoTitleConversation(conv) {
  const lm = getLanguageModel();
  if (!lm) return;
  try {
    let session;
    try {
      session = await lm.create({
        initialPrompts: [{ role: 'system', content: 'Generate a very short title (3-5 words max) for this chat. Reply with ONLY the title.' }]
      });
    } catch {
      session = await lm.create({
        systemPrompt: 'Generate a very short title (3-5 words max) for this chat. Reply with ONLY the title.'
      });
    }
    const title = await session.prompt(conv.messages[0].content);
    session.destroy();
    conv.title = title.trim().replace(/^["']|["']$/g, '').slice(0, 50);
    saveConversations();
    renderConversationList();
  } catch { /* silent fail */ }
}

// ─── Quick Actions ────────────────────────────────────────
async function handleQuickAction(action) {
  const ctx = await getPageContext();
  const pageText = ctx?.text || '';
  const selected = ctx?.selected || '';
  const title = ctx?.meta?.title || '';
  const contentForAI = selected || pageText;

  const prompts = {
    summarize: `Summarize this page ("${title}") in clear bullet points:\n\n${contentForAI || '(No page content available)'}`,
    extract: `Extract all key facts, data, names, dates, and numbers from this page ("${title}"):\n\n${contentForAI || '(No page content available)'}`,
    translate: `Translate the following to ${contentForAI ? 'English (or Bengali if already English)' : 'English'}:\n\n${contentForAI || '(Select text on the page first)'}`,
    explain: `Explain this in simple terms:\n\n${contentForAI || '(No page content available)'}`,
    write: 'I need help writing. What would you like me to help write? (email, essay, code, message, social post, etc.)'
  };

  const prompt = prompts[action];
  if (prompt) {
    inputEl.value = '';
    await sendMessage(prompt, true); // skipContext since we already included it
  }
}

// ─── Auto-resize Textarea ─────────────────────────────────
function autoResize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
}

// ─── Status ───────────────────────────────────────────────
function setStatus(type, msg) {
  if (statusDot) statusDot.className = 'status-dot ' + type;
  if (statusText) statusText.textContent = msg;
}

// ─── Event Listeners ──────────────────────────────────────
// Send
sendBtn?.addEventListener('click', () => {
  const text = inputEl.value.trim();
  if (text) { inputEl.value = ''; autoResize(); sendMessage(text); }
});

inputEl?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (text) { inputEl.value = ''; autoResize(); sendMessage(text); }
  }
});

inputEl?.addEventListener('input', autoResize);

// Menu
$('menu-btn')?.addEventListener('click', () => toggleConvPanel(true));
$('close-conv-btn')?.addEventListener('click', () => toggleConvPanel(false));
convOverlay?.addEventListener('click', e => {
  if (e.target === convOverlay) toggleConvPanel(false);
});

// New chat
$('new-chat-btn')?.addEventListener('click', () => {
  createConversation(true);
  toggleConvPanel(false);
  inputEl?.focus();
});

// Quick actions — welcome cards + bottom bar
document.querySelectorAll('[data-action]').forEach(btn => {
  btn.addEventListener('click', () => handleQuickAction(btn.dataset.action));
});

// ─── Init ─────────────────────────────────────────────────
(async function init() {
  setStatus('warn', 'Initializing...');

  // Load conversations
  await loadConversations();

  // If no conversations, create one
  if (conversations.length === 0) {
    createConversation(true);
  }

  // Render
  renderAll();

  // Listeners
  if (agentToggle) {
    agentToggle.addEventListener('change', (e) => {
      isAgentMode = e.target.checked;
    });
  }

  if (stopAgentBtn) {
    stopAgentBtn.addEventListener('click', () => {
      agentLoopActive = false;
      agentStatusBar.classList.add('hidden');
      appendMessageEl('system', '🛑 Agent manually stopped.');
    });
  }

  // Check AI
  const lm = getLanguageModel();
  if (lm) {
    try {
      let avail;
      if (typeof lm.availability === 'function') {
        avail = await lm.availability();
      } else if (typeof lm.capabilities === 'function') {
        const caps = await lm.capabilities();
        avail = caps.available;
      }

      if (avail === 'readily') {
        setStatus('ok', 'Gemini Nano ready');
      } else if (avail === 'after-download' || avail === 'downloading') {
        setStatus('warn', 'Model downloading...');
      } else {
        setStatus('warn', 'Status: ' + (avail || 'unknown'));
      }
    } catch (e) {
      setStatus('warn', 'Checking: ' + e.message);
    }
  } else {
    setStatus('err', 'AI not available — check flags');
  }

  inputEl?.focus();
})();
