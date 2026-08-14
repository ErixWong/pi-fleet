// Markdown 渲染工具：marked 解析 + highlight.js 代码高亮 + DOMPurify 清洗（XSS 安全）
// agent 产出的内容不可信，必须 sanitize 后再 v-html
import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

marked.use(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    },
  }),
);

export function renderMd(src = '') {
  if (!src) return '';
  const raw = marked.parse(src);
  return DOMPurify.sanitize(raw);
}

/**
 * 解析平台附件引用：
 * 1) 显式 `attachment://att-xxxx` → `/api/attachments/att-xxxx`
 * 2) 同任务附件按文件名自动匹配（图文混编）：`![图](图1.png)` / `![](./img/图1.png)` → 该附件 URL
 *
 * @param src  markdown 原文
 * @param attMap 同任务附件映射 { filename小写: attachment_id }（来自交付物引用的附件）
 * agent 本地文件路径（平台无此文件）或外部 URL 保持原样（外部 URL 责任在引用者）。
 */
export function resolveAttachmentRefs(src = '', attMap = {}) {
  if (!src) return '';
  let out = src.replace(/attachment:\/\/([a-zA-Z0-9-]+)/g, '/api/attachments/$1');
  const keys = Object.keys(attMap);
  if (keys.length === 0) return out;
  // 匹配 md 图片/链接引用的 target（不处理以协议开头的 URL）
  out = out.replace(/(!\[([^\]]*)\]|\[[^\]]+\])\(([^)]+)\)/g, (whole, prefix, alt, targetRaw) => {
    const target = targetRaw.trim();
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) return whole; // 外部 URL 不动
    const bare = target.split(/[?#]/, 1)[0].replace(/\\/g, '/').split('/').pop() || '';
    const hit = attMap[bare.toLowerCase()];
    if (!hit) return whole;
    return `${prefix}(/api/attachments/${hit})`;
  });
  return out;
}

/** 渲染 md 并解析平台附件引用（消息流/交付物预览用；attMap 为同任务附件 filename→attachment_id 映射） */
export function renderMdWithAttachments(src = '', attMap = {}) {
  return renderMd(resolveAttachmentRefs(src, attMap));
}
