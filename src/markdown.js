let converter;
export function renderMarkdown(element, text, { library, path = '', openDocument } = {}) {
  const libs = globalThis.SillyTavern?.libs;
  const showdown = libs?.showdown || globalThis.showdown, purifier = libs?.DOMPurify || globalThis.DOMPurify;
  element.classList.add('lh-markdown');
  if (!showdown?.Converter || !purifier?.sanitize) { element.textContent = text; element.style.whiteSpace = 'pre-wrap'; return; }
  converter ??= new showdown.Converter({ tables: true, strikethrough: true, tasklists: true, ghCodeBlocks: true, simplifiedAutoLink: true, literalMidWordUnderscores: true, simpleLineBreaks: false, openLinksInNewWindow: true, backslashEscapesHTMLTags: true });
  const html = converter.makeHtml(String(text || '')).replace(/<img\b[^>]*>/gi, '[图片]');
  element.innerHTML = purifier.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['img','script','style','iframe','object','embed','form','button','video','audio'], FORBID_ATTR: ['style','id','srcset'] });
  for (const image of element.querySelectorAll('img')) {
    const note = document.createElement('span'); note.textContent = `[图片：${image.alt || '图片'}]`; image.replaceWith(note);
  }
  for (const input of element.querySelectorAll('input')) { if (input.type === 'checkbox') input.disabled = true; else input.remove(); }
  for (const link of element.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    else {
      let target;
      try { const resolved = decodeURIComponent(new URL(href, `https://library.invalid/${path}`).pathname).replace(/^\//,''); target = library?.catalog && library.list().find(d => d.path === resolved); } catch {}
      link.removeAttribute('target'); link.removeAttribute('href');
      if (target && openDocument) { link.href = '#'; link.onclick = event => { event.preventDefault(); openDocument(target.id); }; }
      else { link.title = href; link.classList.add('lh-unavailable-link'); }
    }
  }
  for (const pre of element.querySelectorAll('pre')) {
    const wrapper = document.createElement('div'); wrapper.className = 'lh-code-block'; pre.before(wrapper); wrapper.append(pre);
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制'; copy.setAttribute('aria-label','复制代码'); wrapper.prepend(copy);
    copy.onclick = async () => {
      const value = pre.textContent;
      try { await navigator.clipboard.writeText(value); copy.textContent = '已复制'; }
      catch { const textarea = document.createElement('textarea'); textarea.value = value; wrapper.append(textarea); textarea.select(); const ok = document.execCommand('copy'); textarea.remove(); copy.textContent = ok ? '已复制' : '请选中复制'; }
    };
  }
}
