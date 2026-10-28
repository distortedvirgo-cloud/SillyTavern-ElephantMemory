/*
 * Elephant Memory — контекстный перевод через служебную LLM.
 * Здесь только чистые функции и промпты; работа с ST — в index.js.
 */

export const TRANSLATE_PROMPTS = {
    translator_system: `You are a professional literary translator working on an ongoing interactive story (fiction for consenting adults). Translate faithfully and naturally, the way a skilled human translator of novels would.
- Preserve meaning, tone, register, slang, profanity and explicitness exactly. Do not soften, censor, summarize, add or explain anything.
- Keep markup intact: HTML tags and attributes, markdown (*, _, **), quotation marks, line breaks, emoji, and placeholders like ⟦0⟧ must stay exactly where they are. Translate only human-readable text.
- Character names and special terms follow the glossary and stay consistent with previous translations.
- Output only the translation, nothing else.`,

    translate_display: `Glossary (original → translation):
{{glossary}}

Current situation, for context only (do not translate):
{{state}}

Previous messages with their translations, for context and consistency (do not translate them again):
{{context}}

Translate the next message from {{speaker}} into {{target}}:
<text>
{{text}}
</text>`,

    translate_input: `Glossary (original → translation):
{{glossary}}

Previous messages, for context only:
{{context}}

{{user}} wrote their next roleplay message in their own language. Translate it into {{internal}}, the language of the story, as {{user}} would write it: keep their intent, tone and every detail of actions and speech; match the story's tense and style; keep formatting such as *actions*, "speech" and (OOC: ...) as is. Do not add anything.
<text>
{{text}}
</text>`,

    recap: `Story so far:
{{long_term}}

Current state:
{{state}}

Latest messages:
{{messages}}

Write a short recap for the player who is returning to this story, in {{target}}: where they are, who is around, what just happened, and which threads are open. Plain sentences or short bullet points, at most {{max_words}} words. Output only the recap.`,
};

/** Быстрый детерминированный хеш строки (djb2). */
export function hashText(s) {
    const str = String(s ?? '');
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + str.length;
}

/** Есть ли в тексте заметная доля кириллицы (сообщение написано по-русски). */
export function hasCyrillic(text) {
    const letters = String(text ?? '').match(/\p{L}/gu) ?? [];
    if (!letters.length) return false;
    const cyr = letters.filter(ch => /[Ѐ-ӿ]/.test(ch)).length;
    return cyr / letters.length > 0.3;
}

/**
 * Прячет от переводчика то, что переводить нельзя: HTML-комментарии,
 * <style>/<script>, блоки кода и (опционально) целые VTK-вставки.
 */
export function maskProtected(text, { maskVtk = false } = {}) {
    const parts = [];
    const put = m => {
        parts.push(m);
        return `⟦${parts.length - 1}⟧`;
    };
    let t = String(text ?? '');
    if (maskVtk) t = t.replace(/<!--\s*VTK_START\s*-->[\s\S]*?<!--\s*VTK_END\s*-->/gi, put);
    t = t.replace(/<style[\s\S]*?<\/style>/gi, put);
    t = t.replace(/<script[\s\S]*?<\/script>/gi, put);
    t = t.replace(/```[\s\S]*?```/g, put);
    t = t.replace(/<!--[\s\S]*?-->/g, put);
    return { masked: t, parts };
}

/** Возвращает спрятанные куски на место; потерянные переводчиком — дописывает в конец. */
export function unmaskProtected(text, parts) {
    const used = new Set();
    let t = String(text ?? '').replace(/⟦(\d+)⟧/g, (all, n) => {
        const i = Number(n);
        if (i < parts.length && !used.has(i)) {
            used.add(i);
            return parts[i];
        }
        return '';
    });
    const lost = parts.filter((_, i) => !used.has(i));
    if (lost.length) t = t.trimEnd() + '\n' + lost.join('\n');
    return t;
}

/** Убирает обёртки, которые модели иногда добавляют вокруг перевода. */
export function cleanTranslation(text) {
    let t = String(text ?? '').trim();
    const m = t.match(/^<text>\s*([\s\S]*?)\s*<\/text>$/i);
    if (m) t = m[1];
    t = t.replace(/^(?:translation|перевод)\s*:\s*\n/i, '');
    return t.trim();
}

/** Объединяет общий и чатовый глоссарии; строки вида «Original = Перевод». */
export function mergeGlossary(...sources) {
    const lines = [];
    const seen = new Set();
    for (const src of sources) {
        for (const raw of String(src ?? '').split('\n')) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const key = line.split(/=|→|->/)[0].trim().toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            lines.push(line);
        }
    }
    return lines.join('\n');
}

/**
 * Пары «оригинал / перевод» для предыдущих сообщений — переводчик держит
 * единые имена и стиль. Берём только сообщения, у которых перевод есть.
 */
/** Укорачивает сообщение для контекста: без VTK, комментариев и стилей. */
export function stripForContext(text, maxChars = 1200) {
    let t = String(text ?? '')
        .replace(/<!--\s*VTK_START\s*-->[\s\S]*?<!--\s*VTK_END\s*-->/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
    if (t.length > maxChars) t = t.slice(0, maxChars) + '…';
    return t;
}

export function buildContextPairs(chat, beforeIdx, count, names = {}) {
    const out = [];
    for (let i = beforeIdx - 1; i >= 0 && out.length < count; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        const name = m.name || (m.is_user ? names.user : names.char) || (m.is_user ? 'User' : 'Character');
        const tr = m.extra?.display_text;
        if (tr && tr !== m.mes) out.unshift(`[${name} — original]\n${stripForContext(m.mes)}\n[${name} — translation]\n${stripForContext(tr)}`);
        else out.unshift(`[${name}]\n${stripForContext(m.mes)}`);
    }
    return out.join('\n\n');
}

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
