/*
 * Elephant Memory — автоматическая память для SillyTavern.
 *
 * Идея: дорогая модель (рассказчик) видит только короткое окно последних
 * сообщений + сжатую память. Всю служебную работу делает дешёвая модель:
 *   1. Летописец сжимает выпавшие из окна сообщения в сводки сцен,
 *      а старые сводки сцен — в сводки арок.
 *   2. Летописец ведёт «карточку состояния» (где, кто, отношения, факты).
 *   3. «Золотая рыбка» — свежий вызов без истории — проверяет карточку
 *      на потери и выдумки, и при необходимости её исправляют.
 *   4. (опционально) Рыбка проверяет ответы рассказчика на противоречия.
 *
 * Расширение не импортирует внутренние модули ST — только SillyTavern.getContext(),
 * поэтому оно меньше ломается при обновлениях.
 */

import {
    TRANSLATE_PROMPTS, hashText, hasCyrillic, maskProtected, unmaskProtected,
    cleanTranslation, mergeGlossary, buildContextPairs, escapeHtml,
} from './translate.js';

export const MODULE = 'elephant_memory';
const KEY_LONGTERM = 'elephant_memory_longterm';
const KEY_STATE = 'elephant_memory_state';
const POS = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };

// ---------------------------------------------------------------------------
// Промпты по умолчанию (на английском — модели следуют им точнее и это дешевле;
// результат пишется на языке ролевой игры).
// ---------------------------------------------------------------------------
export const DEFAULT_PROMPTS = {
    chronicler_system: `You are the Chronicler: a precise, unimaginative record-keeper for an ongoing roleplay between {{user}} and {{char}}. You never invent facts and never continue the story. You only record what has actually happened.`,

    state: `Current state card (may be empty):
<state>
{{previous_state}}
</state>

Earlier story summary (reference only — do not copy it into the card):
<story_so_far>
{{long_term}}
</story_so_far>

New messages since the card was last updated:
<messages>
{{messages}}
</messages>

Update the state card so that it describes the situation AFTER the last message.
Rules:
- Keep only what matters for continuing the story: current scene, who is present, physical and emotional condition, relationships and how they changed, promises, secrets, goals, open plot threads, important items, injuries; clothing only if it matters.
- Remove what is no longer true or relevant. Keep facts that are still true even if they were not mentioned recently.
- Never invent anything that is not in the card or the messages.
- Write in the same language the roleplay is written in (translate the headings too).
- At most {{max_words}} words. Use this structure:

## Scene
Time / place:
Present:
Happening now:
## Characters
- Name: condition, mood, goals
## Relationships
- A ↔ B: ...
## Facts, promises, secrets
- ...
## Open threads
- ...
## Items
- ...

Output only the card.`,

    scene: `Messages from the roleplay:
<messages>
{{messages}}
</messages>

Summarize these messages as one scene of the story.
- Past tense, third person, concrete: who did what, what was decided, what changed (relationships, injuries, items, locations, knowledge), important things said (paraphrased).
- No commentary, no evaluation, no invented details.
- Write in the same language the roleplay is written in.
- At most {{max_words}} words. Output only the summary.`,

    arc: `Consecutive scene summaries of a roleplay, oldest first:
<scenes>
{{scenes}}
</scenes>

Merge them into one chapter summary.
- Keep cause and effect, decisions, changes in relationships, facts that may matter later. Drop moment-to-moment detail.
- Past tense, no commentary, no invented details.
- Write in the same language the roleplay is written in.
- At most {{max_words}} words. Output only the summary.`,

    goldfish_system: `You are a strict reviewer who sees this material for the first time. You have no other context and you do not care about style — only about accuracy.`,

    goldfish: `Source messages from a roleplay:
<messages>
{{messages}}
</messages>

The previous state card:
<previous_state>
{{previous_state}}
</previous_state>

A NEW state card that was written from them:
<new_state>
{{new_state}}
</new_state>

Find concrete problems in the NEW card:
1. MISSING — a fact from the messages or the previous card that is still true and will matter later, but is absent.
2. INVENTED — a claim supported neither by the messages nor by the previous card.
3. WRONG — a contradiction with the messages (wrong place, wrong people present, wrong relationship, wrong order of events).
Ignore wording, style and trivia.
If there are no real problems, answer exactly: OK
Otherwise answer with a short list, one problem per line, each line starting with MISSING:, INVENTED: or WRONG:`,

    fix: `State card:
<state>
{{new_state}}
</state>

Source messages:
<messages>
{{messages}}
</messages>

A reviewer found these problems in the card:
<problems>
{{problems}}
</problems>

Rewrite the card fixing every valid problem. Keep the same structure, language and length limit ({{max_words}} words). Do not invent anything. Output only the corrected card.`,

    reply_check: `State card of the story:
<state>
{{state}}
</state>

Messages right before the reply:
<messages>
{{messages}}
</messages>

New reply from {{char}}:
<reply>
{{reply}}
</reply>

Does the new reply HARD-contradict the state card or the messages? Hard contradictions: a character acts who is absent or dead, the wrong location, a forgotten injury, item or established fact that breaks continuity, a relationship that is suddenly different without reason.
New details that do not conflict are fine. Ignore style and quality.
Answer exactly OK, or one line: CONTRADICTION: <short explanation in the language of the roleplay>`,

    ...TRANSLATE_PROMPTS,
};

export const DEFAULT_SETTINGS = {
    enabled: true,
    helperProfile: '',
    criticProfile: '',
    helperMaxTokens: 2500,
    keepRecent: 20,
    sceneChunk: 10,
    stateEvery: 6,
    stateMaxMessages: 30,
    stateMaxWords: 400,
    sceneMaxWords: 150,
    arcMaxWords: 300,
    scenesBeforeArc: 10,
    keepScenes: 4,
    maxChunksPerRun: 2,
    goldfishState: true,
    replyCheck: 'off', // off | notify | auto
    maxRetries: 1,
    stateDepth: 4,
    waitMs: 30000,
    // Перевод
    translateEnabled: false,
    translatorProfile: '',
    translateTarget: 'Russian',
    translateInternal: 'English',
    translateIncoming: true,
    translateOutgoing: true,
    translateImpersonate: true,
    translateContext: 2,
    translateVtk: true,
    translateMaxTokens: 3000,
    glossary: '',
    // Пересказ
    recapWords: 150,
    recapOnOpenHours: 0,
    prompts: { ...DEFAULT_PROMPTS },
};

export function emptyData() {
    return {
        version: 1,
        state: '',
        stateUpTo: 0,
        scenes: [], // { from, to, text }
        arcs: [], // { from, to, text }
        summarizedUpTo: 0,
        anchor: null,
        warnedBacklog: false,
        lastReview: '',
        lastReplyCheck: '',
        glossary: '',
    };
}

// ---------------------------------------------------------------------------
// Чистые функции (покрыты тестами)
// ---------------------------------------------------------------------------

export function keyOf(m) {
    if (!m) return '';
    return `${m.send_date ?? ''}|${m.name ?? ''}|${m.is_user ? 1 : 0}`;
}

export function cleanText(t) {
    return String(t ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .trim();
}

/** Форматирует сообщения [from, to) для служебной модели. Скрытые (is_system) пропускаются. */
export function formatMessages(chat, from, to, names = {}) {
    const lines = [];
    for (let i = Math.max(0, from); i < Math.min(to, chat.length); i++) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        const name = m.name || (m.is_user ? names.user : names.char) || (m.is_user ? 'User' : 'Character');
        const text = cleanText(m.mes);
        if (!text) continue;
        lines.push(`#${i} ${name}: ${text}`);
    }
    return lines.join('\n\n');
}

/**
 * Планирует обслуживание памяти.
 * Последнее сообщение не трогаем: его ещё могут свайпнуть.
 */
export function planMaintenance(chatLen, data, s) {
    const settledEnd = Math.max(0, chatLen - 1);
    const cutoff = Math.max(0, chatLen - s.keepRecent);
    const end = Math.min(cutoff, settledEnd);
    const sceneChunks = [];
    let from = Math.min(data.summarizedUpTo, chatLen);
    while (s.sceneChunk > 0 && end - from >= s.sceneChunk) {
        sceneChunks.push([from, from + s.sceneChunk]);
        from += s.sceneChunk;
    }
    const needState = settledEnd > 0 && settledEnd - Math.min(data.stateUpTo, settledEnd) >= s.stateEvery;
    return { settledEnd, sceneChunks, needState };
}

/** Сколько самых старых сводок сцен надо слить в арку (0 — не надо). */
export function arcMergeCount(scenesLen, s) {
    if (scenesLen <= s.scenesBeforeArc) return 0;
    return Math.max(2, scenesLen - s.keepScenes);
}

export function isOk(verdict) {
    const v = String(verdict ?? '').trim().replace(/^[*_`"'\s]+|[*_`"'.\s]+$/g, '');
    return /^ok$/i.test(v);
}

export function parseReplyCheck(verdict) {
    const v = String(verdict ?? '').trim();
    if (!v || isOk(v)) return { ok: true, reason: '' };
    const m = v.match(/CONTRADICTION\s*:\s*([\s\S]*)/i);
    if (m) return { ok: false, reason: m[1].trim().split('\n')[0] };
    // Неразборчивый ответ не считаем противоречием — лишняя перегенерация дороже.
    return { ok: true, reason: '' };
}

export function fillTemplate(tpl, vars) {
    return String(tpl).replace(/\{\{(\w+)\}\}/g, (all, k) => (Object.hasOwn(vars, k) ? String(vars[k] ?? '') : all));
}

export function buildLongTerm(data) {
    const parts = [];
    for (const a of data.arcs) parts.push(`[Chapter, messages ${a.from}–${a.to - 1}]\n${a.text}`);
    for (const sc of data.scenes) parts.push(`[Scene, messages ${sc.from}–${sc.to - 1}]\n${sc.text}`);
    if (!parts.length) return '';
    return `<story_so_far>\nWhat happened earlier in this story (older chat messages are replaced by this summary):\n\n${parts.join('\n\n')}\n</story_so_far>`;
}

export function buildStateBlock(data) {
    if (!data.state) return '';
    return `<current_state>\nCurrent state of the story — keep the reply consistent with it:\n${data.state}\n</current_state>`;
}

/** Сериализация списков сводок для редактирования в textarea и обратно. */
export function entriesToText(list) {
    return list.map(e => `[${e.from}-${e.to}]\n${e.text}`).join('\n=====\n');
}

export function textToEntries(text) {
    return String(text ?? '')
        .split(/^\s*=====\s*$/m)
        .map(block => block.trim())
        .filter(Boolean)
        .map(block => {
            const m = block.match(/^\[(\d+)\s*-\s*(\d+)\]\s*\n?([\s\S]*)$/);
            if (m) return { from: Number(m[1]), to: Number(m[2]), text: m[3].trim() };
            return { from: 0, to: 0, text: block };
        });
}

/**
 * Помечает в копии чата (которую ST собирает для промпта) сообщения,
 * уже покрытые сводками, флагом «игнорировать». Возвращает число скрытых.
 */
export function hideSummarized(promptChat, realChat, upTo, ignoreSymbol, protectTail = 2) {
    const n = Math.min(upTo, realChat.length);
    if (n <= 0) return 0;
    const refs = new Set(realChat.slice(0, n));
    const keys = new Set(realChat.slice(0, n).map(keyOf));
    let hidden = 0;
    for (let i = 0; i < promptChat.length - protectTail; i++) {
        const m = promptChat[i];
        if (!m) continue;
        if (refs.has(m) || (m.send_date && keys.has(keyOf(m)))) {
            promptChat[i] = { ...m, extra: { ...(m.extra || {}), [ignoreSymbol]: true } };
            hidden++;
        }
    }
    return hidden;
}

// ---------------------------------------------------------------------------
// Работа внутри SillyTavern
// ---------------------------------------------------------------------------

const ctx = () => globalThis.SillyTavern.getContext();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ask(text) {
    const c = ctx();
    if (c.Popup?.show?.confirm) return Boolean(await c.Popup.show.confirm('Elephant Memory', text));
    return globalThis.confirm(text);
}

const toast = () => globalThis.toastr ?? { info: console.info, warning: console.warn, error: console.error, success: console.info };

let busy = null;
let stopRequested = false;
const retries = new Map();

export function settings() {
    const es = ctx().extensionSettings;
    if (!es[MODULE]) es[MODULE] = structuredClone(DEFAULT_SETTINGS);
    const s = es[MODULE];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    for (const [k, v] of Object.entries(DEFAULT_PROMPTS)) {
        if (!s.prompts[k]) s.prompts[k] = v;
    }
    return s;
}

function hasChat() {
    const c = ctx();
    return Boolean(c.getCurrentChatId?.()) && Array.isArray(c.chat);
}

function getData() {
    if (!hasChat()) return null;
    const meta = ctx().chatMetadata;
    if (!meta) return null;
    if (!meta[MODULE]) meta[MODULE] = emptyData();
    const d = meta[MODULE];
    for (const [k, v] of Object.entries(emptyData())) if (d[k] === undefined) d[k] = v;
    return d;
}

async function saveData() {
    const c = ctx();
    if (typeof c.saveMetadata === 'function') await c.saveMetadata();
    else c.saveMetadataDebounced?.();
}

function names() {
    const c = ctx();
    return { user: c.name1, char: c.name2 };
}

function subst(text) {
    const c = ctx();
    return typeof c.substituteParams === 'function' ? c.substituteParams(text) : text;
}

const truncationWarned = new Set();

/** Вызов дешёвой модели. role: 'helper' | 'critic' | 'translator'. */
async function callModel(systemText, userText, role = 'helper', maxTokensOverride = null) {
    const s = settings();
    const c = ctx();
    const profileId = role === 'critic' ? (s.criticProfile || s.helperProfile)
        : role === 'translator' ? (s.translatorProfile || s.helperProfile)
            : s.helperProfile;
    const maxTokens = Number(maxTokensOverride ?? s.helperMaxTokens);
    const messages = [
        { role: 'system', content: subst(systemText) },
        { role: 'user', content: subst(userText) },
    ];
    let out;
    if (profileId && c.ConnectionManagerRequestService) {
        const res = await c.ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, {
            stream: false,
            extractData: true,
            includePreset: false,
            includeInstruct: true,
        });
        out = typeof res === 'string' ? res : res?.content;
    } else {
        out = await c.generateRaw({ prompt: messages, responseLength: maxTokens });
    }
    out = cleanText(out);
    warnIfTruncated(out, maxTokens, role);
    return out;
}

/** Предупреждает, если ответ служебной модели, похоже, упёрся в лимит токенов. */
async function warnIfTruncated(text, maxTokens, role) {
    try {
        const c = ctx();
        if (!text || truncationWarned.has(role) || typeof c.getTokenCountAsync !== 'function') return;
        const n = await c.getTokenCountAsync(text);
        if (n < maxTokens * 0.95) return;
        truncationWarned.add(role);
        const where = role === 'translator' ? '«Макс. токенов перевода»' : '«Макс. токенов ответа служебной модели»';
        toast().warning(`Ответ служебной модели (~${n} ток.) упёрся в лимит и, вероятно, обрезан. Увеличьте ${where} в продвинутых настройках.`, 'Elephant Memory', { timeOut: 20000 });
    } catch (e) {
        console.debug('[Elephant Memory] token count', e);
    }
}

function chatStillSame(chatId) {
    return hasChat() && ctx().getCurrentChatId() === chatId;
}

function validateAnchor(data) {
    const chat = ctx().chat;
    if (data.summarizedUpTo > chat.length) {
        data.summarizedUpTo = Math.max(0, chat.length - 1);
        data.desync = true;
    } else if (data.summarizedUpTo > 0 && data.anchor && keyOf(chat[data.summarizedUpTo - 1]) !== data.anchor) {
        data.desync = true;
    }
    if (data.stateUpTo > chat.length) data.stateUpTo = chat.length;
    if (data.desync && !data.desyncWarned) {
        data.desyncWarned = true;
        toast().warning('Старые сообщения были удалены или изменены. Если память стала неточной — нажмите «Пересобрать память».', 'Elephant Memory');
    }
}

async function summarizeScene(chat, from, to) {
    const s = settings();
    const text = formatMessages(chat, from, to, names());
    if (!text) return '';
    return callModel(s.prompts.chronicler_system, fillTemplate(s.prompts.scene, { messages: text, max_words: s.sceneMaxWords }));
}

async function mergeArc(entries) {
    const s = settings();
    const scenes = entries.map(e => `[messages ${e.from}–${e.to - 1}]\n${e.text}`).join('\n\n');
    return callModel(s.prompts.chronicler_system, fillTemplate(s.prompts.arc, { scenes, max_words: s.arcMaxWords }));
}

async function updateState(data, settledEnd, chatId) {
    const s = settings();
    const chat = ctx().chat;
    const from = Math.max(Math.min(data.stateUpTo, settledEnd), settledEnd - s.stateMaxMessages);
    const messages = formatMessages(chat, from, settledEnd, names());
    if (!messages) {
        data.stateUpTo = settledEnd;
        return;
    }
    const longTerm = [...data.arcs, ...data.scenes].map(e => e.text).join('\n\n') || '(none)';
    let newState = await callModel(s.prompts.chronicler_system, fillTemplate(s.prompts.state, {
        previous_state: data.state || '(empty)',
        long_term: longTerm,
        messages,
        max_words: s.stateMaxWords,
    }));
    if (!chatStillSame(chatId) || stopRequested) return;
    if (!newState) throw new Error('Служебная модель вернула пустую карточку');

    data.lastReview = '';
    if (s.goldfishState) {
        const verdict = await callModel(s.prompts.goldfish_system, fillTemplate(s.prompts.goldfish, {
            messages,
            previous_state: data.state || '(empty)',
            new_state: newState,
        }), 'critic');
        if (!chatStillSame(chatId) || stopRequested) return;
        if (verdict && !isOk(verdict)) {
            data.lastReview = verdict;
            const fixed = await callModel(s.prompts.chronicler_system, fillTemplate(s.prompts.fix, {
                new_state: newState,
                messages,
                problems: verdict,
                max_words: s.stateMaxWords,
            }));
            if (!chatStillSame(chatId) || stopRequested) return;
            if (fixed) newState = fixed;
        } else {
            data.lastReview = 'OK';
        }
    }
    data.state = newState;
    data.stateUpTo = settledEnd;
}

/**
 * Основной цикл обслуживания памяти.
 * manual=true — снимает ограничение на число сводок за раз (пересборка).
 * forceState=true — обновить карточку, даже если порог не достигнут.
 */
export function maintain({ manual = false, forceState = false } = {}) {
    if (busy) return busy;
    busy = (async () => {
        const s = settings();
        if (!s.enabled || !hasChat()) return;
        const chatId = ctx().getCurrentChatId();
        const data = getData();
        if (!data) return;
        validateAnchor(data);

        const chat = ctx().chat;
        const plan = planMaintenance(chat.length, data, s);
        let chunks = plan.sceneChunks;

        if (!manual && chunks.length > s.maxChunksPerRun) {
            if (!data.warnedBacklog) {
                data.warnedBacklog = true;
                toast().info(`В этом чате ${chunks.length} несжатых блоков. Сжимаю постепенно по ${s.maxChunksPerRun} за ход. Чтобы сжать всё сразу, нажмите «Пересобрать память».`, 'Elephant Memory');
            }
            chunks = chunks.slice(0, s.maxChunksPerRun);
        }

        let changed = false;
        let i = 0;
        for (const [from, to] of chunks) {
            if (stopRequested || !chatStillSame(chatId)) return;
            if (manual && chunks.length > 1) setStatus(`Сжимаю блок ${++i} из ${chunks.length}…`);
            const text = await summarizeScene(chat, from, to);
            if (!chatStillSame(chatId) || stopRequested) return;
            data.scenes.push({ from, to, text: text || '(empty)' });
            data.summarizedUpTo = to;
            data.anchor = keyOf(chat[to - 1]);
            changed = true;
            await saveData();
            applyInjections();
        }

        let guard = 0;
        let mergeN = arcMergeCount(data.scenes.length, s);
        while (mergeN > 0 && guard++ < 50) {
            if (stopRequested || !chatStillSame(chatId)) return;
            const batch = data.scenes.slice(0, mergeN);
            setStatus('Объединяю сцены в главу…');
            const text = await mergeArc(batch);
            if (!chatStillSame(chatId) || stopRequested) return;
            if (!text) break;
            data.arcs.push({ from: batch[0].from, to: batch[batch.length - 1].to, text });
            data.scenes.splice(0, mergeN);
            changed = true;
            await saveData();
            mergeN = arcMergeCount(data.scenes.length, s);
        }

        if (plan.needState || (forceState && plan.settledEnd > 0)) {
            setStatus('Обновляю карточку состояния…');
            await updateState(data, plan.settledEnd, chatId);
            if (!chatStillSame(chatId)) return;
            changed = true;
            await saveData();
        }

        if (changed) applyInjections();
    })()
        .catch(err => {
            console.error('[Elephant Memory]', err);
            toast().error(String(err?.cause?.message || err?.message || err), 'Elephant Memory: ошибка служебной модели');
        })
        .finally(() => {
            busy = null;
            stopRequested = false;
            setStatus('');
            refreshUI();
        });
    return busy;
}

export function applyInjections() {
    const c = ctx();
    const s = settings();
    const data = s.enabled ? getData() : null;
    const lt = data ? buildLongTerm(data) : '';
    const st = data ? buildStateBlock(data) : '';
    c.setExtensionPrompt(KEY_LONGTERM, lt, POS.IN_PROMPT, 0);
    c.setExtensionPrompt(KEY_STATE, st, POS.IN_CHAT, Number(s.stateDepth), false, 0);
}

async function checkReply(mesId) {
    const s = settings();
    if (!s.enabled || s.replyCheck === 'off' || !hasChat()) return;
    const c = ctx();
    const chat = c.chat;
    const data = getData();
    const idx = Number.isInteger(mesId) ? mesId : chat.length - 1;
    const msg = chat[idx];
    if (!data?.state || !msg || msg.is_user || msg.is_system || idx !== chat.length - 1) return;

    const chatId = c.getCurrentChatId();
    const verdict = await callModel(s.prompts.goldfish_system, fillTemplate(s.prompts.reply_check, {
        state: data.state,
        messages: formatMessages(chat, Math.max(0, idx - 2), idx, names()),
        reply: cleanText(msg.mes),
    }), 'critic');
    if (!chatStillSame(chatId)) return;
    const res = parseReplyCheck(verdict);
    data.lastReplyCheck = res.ok ? `#${idx}: OK` : `#${idx}: ${res.reason}`;
    refreshUI();
    if (res.ok) return;

    const key = `${chatId}:${idx}`;
    const used = retries.get(key) ?? 0;
    if (s.replyCheck === 'auto' && used < Number(s.maxRetries)) {
        retries.set(key, used + 1);
        toast().info(`Противоречие: ${res.reason}. Перегенерирую ответ.`, 'Рыбка');
        await c.swipe?.right?.(null, { source: 'auto_swipe' });
        return true;
    } else {
        toast().warning(res.reason, 'Рыбка: возможное противоречие', { timeOut: 15000 });
    }
}

// ---------------------------------------------------------------------------
// Контекстный перевод
// ---------------------------------------------------------------------------

const translating = new Set();

function glossaryText() {
    const s = settings();
    return mergeGlossary(getData()?.glossary, s.glossary) || '(none)';
}

function isPlaceholderText(mes) {
    const t = String(mes ?? '').trim();
    return !t || t === '...';
}

function refreshMessage(idx) {
    const c = ctx();
    const m = c.chat[idx];
    if (m && typeof c.updateMessageBlock === 'function') c.updateMessageBlock(idx, m);
}

/** Переводит сообщение для показа (оригинал остаётся в промпте). */
export async function translateForDisplay(idx, { force = false } = {}) {
    const s = settings();
    const c = ctx();
    const chat = c.chat;
    const m = chat?.[idx];
    if (!m || m.is_system || isPlaceholderText(m.mes)) return false;
    if (typeof m.extra !== 'object' || !m.extra) m.extra = {};

    const src = hashText(m.mes);
    if (!force && m.extra.em_tr?.src === src) {
        if (m.extra.display_text !== m.extra.em_tr.text) {
            m.extra.display_text = m.extra.em_tr.text;
            refreshMessage(idx);
        }
        return true;
    }

    const key = `${c.getCurrentChatId?.()}:${idx}:${src}`;
    if (translating.has(key)) return false;
    translating.add(key);
    try {
        const chatId = c.getCurrentChatId?.();
        const { masked, parts } = maskProtected(m.mes, { maskVtk: !s.translateVtk });
        const nm = names();
        const speaker = m.name || (m.is_user ? nm.user : nm.char);
        const raw = await callModel(s.prompts.translator_system, fillTemplate(s.prompts.translate_display, {
            glossary: glossaryText(),
            state: getData()?.state || '(none)',
            context: buildContextPairs(chat, idx, Number(s.translateContext), nm) || '(none)',
            speaker,
            target: s.translateTarget,
            text: masked,
        }), 'translator', s.translateMaxTokens);
        const out = cleanTranslation(raw);
        // Чат сменился или сообщение изменилось, пока шёл перевод
        if (!out || c.getCurrentChatId?.() !== chatId || hashText(ctx().chat[idx]?.mes) !== src) return false;
        const text = unmaskProtected(out, parts);
        m.extra.em_tr = { src, text };
        m.extra.display_text = text;
        refreshMessage(idx);
        await c.saveChat?.();
        return true;
    } catch (e) {
        console.error('[Elephant Memory] translate', e);
        toast().error(String(e?.cause?.message || e?.message || e), 'Elephant Memory: ошибка перевода');
        return false;
    } finally {
        translating.delete(key);
    }
}

/** Переводит сообщение пользователя на язык истории до отправки модели. */
export async function translateOutgoing(idx) {
    const s = settings();
    if (!s.translateEnabled || !s.translateOutgoing) return;
    const c = ctx();
    const m = c.chat?.[idx];
    if (!m || !m.is_user || m.is_system || !hasCyrillic(m.mes)) return;
    if (typeof m.extra !== 'object' || !m.extra) m.extra = {};
    const original = m.mes;
    try {
        const { masked, parts } = maskProtected(original);
        const raw = await callModel(s.prompts.translator_system, fillTemplate(s.prompts.translate_input, {
            glossary: glossaryText(),
            context: buildContextPairs(c.chat, idx, Number(s.translateContext), names()) || '(none)',
            internal: s.translateInternal,
            text: masked,
        }), 'translator', s.translateMaxTokens);
        const out = cleanTranslation(raw);
        if (!out) return;
        m.mes = unmaskProtected(out, parts);
        m.extra.display_text = original;
        m.extra.em_tr = { src: hashText(m.mes), text: original };
        refreshMessage(idx);
    } catch (e) {
        console.error('[Elephant Memory] translate input', e);
        toast().error('Не удалось перевести ваше сообщение — отправлено как есть.', 'Elephant Memory');
    }
}

/** Перевод текста имперсонации в поле ввода на язык пользователя. */
async function translateImpersonation() {
    const s = settings();
    if (!s.translateEnabled || !s.translateImpersonate || !globalThis.jQuery) return;
    const $ta = globalThis.jQuery('#send_textarea');
    const text = String($ta.val() ?? '');
    if (!text.trim() || hasCyrillic(text)) return;
    const { masked, parts } = maskProtected(text);
    const raw = await callModel(s.prompts.translator_system, fillTemplate(s.prompts.translate_display, {
        glossary: glossaryText(),
        state: getData()?.state || '(none)',
        context: buildContextPairs(ctx().chat, ctx().chat.length, Number(s.translateContext), names()) || '(none)',
        speaker: names().user,
        target: s.translateTarget,
        text: masked,
    }), 'translator', s.translateMaxTokens);
    const out = cleanTranslation(raw);
    if (out) $ta.val(unmaskProtected(out, parts)).trigger('input');
}

/** Кнопка 🌐 на сообщении: перевод ⇄ оригинал. */
export async function toggleTranslation(idx) {
    const c = ctx();
    const m = c.chat?.[idx];
    if (!m) return;
    if (typeof m.extra !== 'object' || !m.extra) m.extra = {};
    if (m.extra.display_text) {
        delete m.extra.display_text;
        refreshMessage(idx);
        await c.saveChat?.();
        return;
    }
    if (m.extra.em_tr?.src === hashText(m.mes)) {
        m.extra.display_text = m.extra.em_tr.text;
        refreshMessage(idx);
        await c.saveChat?.();
        return;
    }
    await translateForDisplay(idx, { force: true });
}

/** После правки или свайпа: подставить сохранённый перевод или перевести заново. */
export async function syncTranslation(idx) {
    const s = settings();
    const c = ctx();
    const m = c.chat?.[idx];
    if (!m?.extra?.em_tr && !(s.translateEnabled && s.translateIncoming && !m?.is_user)) return;
    if (!m || isPlaceholderText(m.mes)) return;
    if (m.extra?.em_tr?.src === hashText(m.mes)) {
        if (!m.extra.display_text) {
            m.extra.display_text = m.extra.em_tr.text;
            refreshMessage(idx);
        }
        return;
    }
    // Текст изменился — старый перевод больше не соответствует
    if (m.extra?.em_tr) {
        delete m.extra.em_tr;
        delete m.extra.display_text;
        refreshMessage(idx);
    }
    if (s.translateEnabled && s.translateIncoming && !m.is_user) await translateForDisplay(idx);
}

function warnBuiltinTranslate() {
    const mode = ctx().extensionSettings?.translate?.auto_mode;
    if (settings().translateEnabled && mode && mode !== 'none') {
        toast().warning('Включён автоперевод встроенного расширения Translate — выключите его (Auto-mode: None), иначе сообщения будут переводиться дважды.', 'Elephant Memory', { timeOut: 20000 });
    }
}

// ---------------------------------------------------------------------------
// Пересказ «где мы остановились»
// ---------------------------------------------------------------------------

export async function showRecap() {
    if (!hasChat()) return '';
    const s = settings();
    const c = ctx();
    const data = getData();
    const chat = c.chat;
    setStatus('Готовлю пересказ…');
    try {
        const text = await callModel(s.prompts.chronicler_system, fillTemplate(s.prompts.recap, {
            long_term: [...data.arcs, ...data.scenes].map(e => e.text).join('\n\n') || '(none)',
            state: data.state || '(none)',
            messages: formatMessages(chat, Math.max(0, chat.length - 6), chat.length, names()) || '(none)',
            target: s.translateTarget,
            max_words: s.recapWords,
        }));
        if (!text) return '';
        const html = `<h3>Где мы остановились</h3><div style="text-align:left">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
        if (c.callGenericPopup) await c.callGenericPopup(html, c.POPUP_TYPE?.TEXT ?? 1, '', { wide: true });
        else toast().info(text, 'Пересказ', { timeOut: 60000 });
        return text;
    } catch (e) {
        console.error('[Elephant Memory] recap', e);
        toast().error(String(e?.message || e), 'Elephant Memory: пересказ');
        return '';
    } finally {
        setStatus('');
    }
}

function lastMessageTime(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        const t = Number(m.gen_finished) || Date.parse(m.send_date);
        if (Number.isFinite(t)) return t;
    }
    return NaN;
}

async function maybeRecapOnOpen() {
    const s = settings();
    const hours = Number(s.recapOnOpenHours);
    if (!hours || !hasChat()) return;
    const data = getData();
    const chat = ctx().chat;
    if (!data || chat.length < 10 || !(data.state || data.scenes.length)) return;
    const last = lastMessageTime(chat);
    if (!Number.isFinite(last) || Date.now() - last < hours * 3600e3) return;
    await showRecap();
}

// Перехватчик генерации: скрывает из промпта сообщения, уже покрытые сводками.
globalThis.elephantMemory_interceptor = async function (chat, contextSize, abort, type) {
    try {
        const s = settings();
        if (!s.enabled || !hasChat()) return;
        if (type === 'quiet') return;
        if (busy) await Promise.race([busy, sleep(Number(s.waitMs))]);
        const data = getData();
        applyInjections();
        if (!data?.summarizedUpTo) return;
        const ignore = ctx().symbols?.ignore ?? Symbol.for('ignore');
        const hidden = hideSummarized(chat, ctx().chat, data.summarizedUpTo, ignore);
        console.debug(`[Elephant Memory] скрыто из промпта сообщений: ${hidden}`);
    } catch (err) {
        console.error('[Elephant Memory] interceptor', err);
    }
};

// ---------------------------------------------------------------------------
// Интерфейс
// ---------------------------------------------------------------------------

const $root = () => globalThis.jQuery('#elephant_memory_settings');

function setStatus(text) {
    if (!globalThis.jQuery) return;
    globalThis.jQuery('#em_busy').text(text || '');
}

let statsTimer = null;

export function refreshUI() {
    if (!globalThis.jQuery || !$root().length) return;
    const $ = globalThis.jQuery;
    const s = settings();
    const data = getData();

    $('#em_profile_warning').toggle(!s.helperProfile);

    if (!data) {
        $('#em_status').text('Откройте чат, чтобы увидеть его память.');
        $('#em_state, #em_scenes, #em_arcs').val('').prop('disabled', true);
        return;
    }
    $('#em_state, #em_scenes, #em_arcs').prop('disabled', false);
    if (!$('#em_chat_glossary').is(':focus')) $('#em_chat_glossary').val(data.glossary ?? '');
    if (!$('#em_state').is(':focus')) $('#em_state').val(data.state);
    if (!$('#em_scenes').is(':focus')) $('#em_scenes').val(entriesToText(data.scenes));
    if (!$('#em_arcs').is(':focus')) $('#em_arcs').val(entriesToText(data.arcs));
    $('#em_review').text(data.lastReview ? `Рыбка о карточке: ${data.lastReview}` : '');
    $('#em_replycheck').text(data.lastReplyCheck ? `Последняя проверка ответа: ${data.lastReplyCheck}` : '');

    const chatLen = ctx().chat.length;
    $('#em_status').text(`Сжато сообщений: ${data.summarizedUpTo} из ${chatLen} · глав: ${data.arcs.length} · сцен: ${data.scenes.length} · карточка до #${data.stateUpTo}`);

    clearTimeout(statsTimer);
    statsTimer = setTimeout(updateTokenStats, 300);
}

async function updateTokenStats() {
    const c = ctx();
    const data = getData();
    if (!data || typeof c.getTokenCountAsync !== 'function') return;
    try {
        const chat = c.chat;
        const hiddenText = chat.slice(0, Math.min(data.summarizedUpTo, chat.length)).filter(m => !m.is_system).map(m => m.mes).join('\n');
        const memText = buildLongTerm(data) + '\n' + buildStateBlock(data);
        const [hidden, mem] = await Promise.all([c.getTokenCountAsync(hiddenText), c.getTokenCountAsync(memText)]);
        const saved = hidden - mem;
        globalThis.jQuery('#em_tokens').text(`Память: ~${mem} ток. вместо ~${hidden} ток. старой истории${saved > 0 ? ` · экономия ~${saved} ток. на каждом запросе` : ''}`);
    } catch (e) {
        console.debug('[Elephant Memory] token stats', e);
    }
}

function bindSettings() {
    const $ = globalThis.jQuery;
    const c = ctx();
    const s = settings();

    $root().find('[data-em-key]').each(function () {
        const key = this.dataset.emKey;
        if (this.type === 'checkbox') this.checked = !!s[key];
        else $(this).val(s[key]);
    }).on('input change', function () {
        const key = this.dataset.emKey;
        if (this.type === 'checkbox') s[key] = this.checked;
        else if (this.type === 'number') s[key] = Number(this.value);
        else s[key] = this.value;
        c.saveSettingsDebounced();
        applyInjections();
        refreshUI();
    });

    // Редактируемые промпты
    const $promptSelect = $('#em_prompt_select');
    for (const k of Object.keys(DEFAULT_PROMPTS)) $promptSelect.append(new Option(k, k));
    const showPrompt = () => $('#em_prompt_text').val(s.prompts[$promptSelect.val()]);
    $promptSelect.on('change', showPrompt);
    $('#em_prompt_text').on('input', function () {
        s.prompts[$promptSelect.val()] = this.value;
        c.saveSettingsDebounced();
    });
    $('#em_prompt_reset').on('click', () => {
        const k = $promptSelect.val();
        s.prompts[k] = DEFAULT_PROMPTS[k];
        showPrompt();
        c.saveSettingsDebounced();
    });
    showPrompt();

    // Профили подключения
    const CMRS = c.ConnectionManagerRequestService;
    if (CMRS?.handleDropdown) {
        try {
            CMRS.handleDropdown('#em_helper_profile', s.helperProfile, (p) => {
                s.helperProfile = p?.id ?? '';
                c.saveSettingsDebounced();
                refreshUI();
            });
            CMRS.handleDropdown('#em_critic_profile', s.criticProfile, (p) => {
                s.criticProfile = p?.id ?? '';
                c.saveSettingsDebounced();
            });
        } catch (e) {
            console.warn('[Elephant Memory] Connection Manager недоступен', e);
            $('#em_profile_warning').text('Расширение Connection Manager выключено — служебные вызовы пойдут через основную модель.').show();
        }
    }

    // Ручное редактирование памяти
    let editTimer = null;
    $('#em_state, #em_scenes, #em_arcs').on('input', function () {
        const data = getData();
        if (!data) return;
        if (this.id === 'em_state') data.state = this.value;
        if (this.id === 'em_scenes') data.scenes = textToEntries(this.value);
        if (this.id === 'em_arcs') data.arcs = textToEntries(this.value);
        clearTimeout(editTimer);
        editTimer = setTimeout(async () => {
            await saveData();
            applyInjections();
            updateTokenStats();
        }, 600);
    });

    $('#em_update_now').on('click', () => maintain({ forceState: true }));
    $('#em_recap').on('click', () => showRecap());
    $('#em_retranslate').on('click', () => {
        const chat = ctx().chat ?? [];
        if (chat.length) translateForDisplay(chat.length - 1, { force: true });
    });
    $('#em_tr_enabled').on('change', () => warnBuiltinTranslate());
    if (CMRS?.handleDropdown) {
        try {
            CMRS.handleDropdown('#em_translator_profile', s.translatorProfile, (p) => {
                s.translatorProfile = p?.id ?? '';
                c.saveSettingsDebounced();
            });
        } catch (e) {
            console.warn('[Elephant Memory] translator dropdown', e);
        }
    }
    let glossaryTimer = null;
    $('#em_chat_glossary').on('input', function () {
        const data = getData();
        if (!data) return;
        data.glossary = this.value;
        clearTimeout(glossaryTimer);
        glossaryTimer = setTimeout(() => saveData(), 600);
    });
    $('#em_rebuild').on('click', rebuildMemory);
    $('#em_stop').on('click', () => {
        if (busy) {
            stopRequested = true;
            setStatus('Останавливаю после текущего вызова…');
        }
    });
    $('#em_clear').on('click', async () => {
        if (!getData()) return;
        if (!(await ask('Стереть всю память этого чата? Сами сообщения не пострадают.'))) return;
        ctx().chatMetadata[MODULE] = emptyData();
        await saveData();
        applyInjections();
        refreshUI();
    });
}

async function rebuildMemory() {
    if (!hasChat()) return;
    if (busy) {
        toast().info('Подождите, память уже обновляется.', 'Elephant Memory');
        return;
    }
    const chat = ctx().chat;
    const s = settings();
    const chunks = Math.max(0, Math.floor((chat.length - s.keepRecent) / s.sceneChunk));
    const calls = chunks + Math.ceil(chunks / Math.max(1, s.scenesBeforeArc - s.keepScenes)) + (s.goldfishState ? 3 : 1);
    if (!(await ask(`Пересобрать память с нуля? Это примерно ${calls} вызовов служебной модели${s.helperProfile ? '' : ' (ВНИМАНИЕ: профиль не выбран — пойдёт через основную модель)'}.`))) return;
    ctx().chatMetadata[MODULE] = emptyData();
    applyInjections();
    await maintain({ manual: true, forceState: true });
    toast().success('Память пересобрана.', 'Elephant Memory');
}

function registerCommands() {
    const c = ctx();
    if (!c.SlashCommandParser || !c.SlashCommand) return;
    const add = (name, helpString, callback) => {
        try {
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({ name, helpString, callback }));
        } catch (e) {
            console.warn('[Elephant Memory] не удалось зарегистрировать команду', name, e);
        }
    };
    add('em-update', 'Elephant Memory: обновить память и карточку состояния сейчас.', async () => {
        await maintain({ forceState: true });
        return '';
    });
    add('em-rebuild', 'Elephant Memory: пересобрать память чата с нуля.', async () => {
        await rebuildMemory();
        return '';
    });
    add('em-state', 'Elephant Memory: вернуть текущую карточку состояния.', async () => getData()?.state ?? '');
    add('em-recap', 'Elephant Memory: краткий пересказ «где мы остановились».', async () => (await showRecap()) || '');
    add('em-translate', 'Elephant Memory: перевести последнее сообщение заново.', async () => {
        const chat = ctx().chat ?? [];
        const idx = chat.length - 1;
        if (idx >= 0) await translateForDisplay(idx, { force: true });
        return '';
    });
}

async function init() {
    const $ = globalThis.jQuery;
    const c = ctx();
    settings();

    const html = await fetch(new URL('./settings.html', import.meta.url)).then(r => r.text());
    $('#extensions_settings2').append(html);
    bindSettings();
    registerCommands();

    const ev = c.eventSource;
    const et = c.eventTypes ?? c.event_types;
    let maintainTimer = null;
    const scheduleMaintain = () => {
        clearTimeout(maintainTimer);
        maintainTimer = setTimeout(() => maintain(), 800);
    };

    ev.on(et.CHAT_CHANGED, () => {
        applyInjections();
        refreshUI();
        scheduleMaintain();
        setTimeout(() => maybeRecapOnOpen(), 1500);
        const s = settings();
        const chat = ctx().chat ?? [];
        if (s.translateEnabled && s.translateIncoming && chat.length === 1 && !chat[0].is_user) translateForDisplay(0);
    });

    // Не ждём здесь служебные вызовы, чтобы не задерживать показ ответа.
    ev.on(et.MESSAGE_RECEIVED, (mesId, type) => {
        if (type === 'impersonate') return;
        const idx = Number(mesId);
        (async () => {
            let regenerated = false;
            try {
                regenerated = await checkReply(idx);
            } catch (e) {
                console.error('[Elephant Memory] reply check', e);
            }
            const s = settings();
            if (!regenerated && s.translateEnabled && s.translateIncoming) await translateForDisplay(idx);
            scheduleMaintain();
            refreshUI();
        })();
    });

    // Сообщение пользователя переводится до сборки промпта — поэтому ждём.
    const onUserRendered = async (mesId) => {
        await translateOutgoing(Number(mesId));
    };
    if (typeof ev.makeFirst === 'function') ev.makeFirst(et.USER_MESSAGE_RENDERED, onUserRendered);
    else ev.on(et.USER_MESSAGE_RENDERED, onUserRendered);

    if (et.IMPERSONATE_READY) {
        ev.on(et.IMPERSONATE_READY, () => translateImpersonation().catch(e => console.error('[Elephant Memory] impersonate', e)));
    }
    if (et.MESSAGE_SWIPED) ev.on(et.MESSAGE_SWIPED, (mesId) => {
        refreshUI();
        syncTranslation(Number(mesId));
    });
    for (const e of [et.MESSAGE_EDITED, et.MESSAGE_UPDATED]) {
        if (e) ev.on(e, (mesId) => {
            refreshUI();
            syncTranslation(Number(mesId));
        });
    }
    if (et.MESSAGE_DELETED) ev.on(et.MESSAGE_DELETED, () => refreshUI());

    // Кнопка 🌐 в меню каждого сообщения
    const $tpl = $('#message_template .extraMesButtons');
    if ($tpl.length && !$tpl.find('.em_tr_toggle').length) {
        $tpl.prepend('<div title="Elephant Memory: перевод ⇄ оригинал" class="mes_button em_tr_toggle fa-solid fa-globe"></div>');
    }
    $(document).on('click', '.em_tr_toggle', function () {
        const idx = Number($(this).closest('.mes').attr('mesid'));
        if (Number.isInteger(idx)) toggleTranslation(idx);
    });
    warnBuiltinTranslate();

    applyInjections();
    refreshUI();
    console.log('[Elephant Memory] загружено');
}

if (typeof globalThis.jQuery === 'function' && globalThis.SillyTavern) {
    globalThis.jQuery(async () => {
        try {
            await init();
        } catch (e) {
            console.error('[Elephant Memory] init failed', e);
        }
    });
}
