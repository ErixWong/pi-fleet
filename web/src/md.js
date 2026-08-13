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
