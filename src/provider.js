// ST host routing follows LittleWhiteBox's independent connection design.
const SOURCES = { openai: 'openai', anthropic: 'claude', google: 'makersuite' };
export function connectionPayload(profile) {
  let url;
  try { url = new URL(profile.baseUrl.trim()); } catch { throw new Error('请填写有效的接口地址。'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('接口地址必须使用 HTTP 或 HTTPS。');
  if (url.username || url.password) throw new Error('请将 API Key 填在密钥栏。');
  if (url.search || url.hash) throw new Error('接口地址请使用不带查询参数的 API 基础地址。');
  url.pathname = url.pathname.replace(/\/(chat\/completions|models|messages)\/?$/, '');
  let base = url.href.replace(/\/+$/, '');
  if (profile.protocol === 'anthropic' && !/\/v\d[\w.-]*$/i.test(base)) base += '/v1';
  if (profile.protocol === 'google') base = base.replace(/\/v\d[\w.-]*$/i, '');
  return { chat_completion_source: SOURCES[profile.protocol] || 'openai', reverse_proxy: base, proxy_password: profile.apiKey || '' };
}
export function extractModels(data) {
  const list = Array.isArray(data) ? data : data.data || data.models;
  if (!Array.isArray(list)) throw new Error('接口没有返回可用的模型列表，可手动填写模型名称。');
  return [...new Set(list.map(m => typeof m === 'string' ? m : m.id || m.name?.replace(/^models\//, '')).filter(Boolean))];
}
function upstreamError(data) {
  if (!data?.error) return null;
  return typeof data.error === 'string' ? data.error : data.error.message || data.message || '模型服务返回错误。';
}
export function extractText(data, protocol) {
  const error = upstreamError(data); if (error) throw new Error(error);
  return data.choices?.[0]?.message?.content
    ?? data.content?.filter(p => p.type === 'text').map(p => p.text).join('')
    ?? data.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('')
    ?? data.text ?? '';
}
export async function readSse(response, onEvent, signal, onDone) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', event = '';
  const consume = line => {
    if (line === '') {
      if (event) {
        const value = event; event = '';
        if (value.trim() === '[DONE]') onDone?.();
        else { let data; try { data = JSON.parse(value); } catch { throw new Error('模型返回的流式数据格式无效，已收到的内容会保留。'); } onEvent(data); }
      }
    }
    else if (line.startsWith('data:')) event += (event ? '\n' : '') + line.slice(5).trimStart();
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, index).replace(/\r$/, '')); buffer = buffer.slice(index + 1); }
      if (done) break;
    }
    if (buffer) consume(buffer.replace(/\r$/, '')); consume('');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function inspectWire(response, signal) {
  // Tavern's stream forwarding may omit Content-Type. Inspect bytes, without buffering the reply.
  if (!response.body) throw new Error('模型连接没有返回内容。');
  const reader = response.body.getReader(), prefix = [];
  let sample = '';
  while (!sample.trim()) {
    signal?.throwIfAborted();
    const { value, done } = await reader.read();
    if (done) { reader.releaseLock(); throw new Error('模型没有返回正文。'); }
    prefix.push(value); sample += new TextDecoder().decode(value);
    if (!sample.trim() && sample.length > 4096) throw new Error('接口返回了无法识别的空白响应。');
  }
  const body = new ReadableStream({
    start(controller) { for (const chunk of prefix) controller.enqueue(chunk); },
    async pull(controller) { try { const { value, done } = await reader.read(); if (done) { controller.close(); reader.releaseLock(); } else controller.enqueue(value); } catch (error) { controller.error(error); } },
    cancel(reason) { return reader.cancel(reason); },
  });
  if (sample.trimStart().startsWith('<')) { await reader.cancel().catch(() => {}); throw new Error('接口返回了网页，请检查是否填写了模型 API 地址。'); }
  return { json: /^[\[{]/.test(sample.trimStart()), response: new Response(body) };
}
export class ModelClient {
  constructor(bridge, fetcher = globalThis.fetch.bind(globalThis)) { this.bridge = bridge; this.fetch = fetcher; this.resolutions = new Map(); }
  async post(path, payload, signal) {
    const response = await this.fetch(path, { method: 'POST', headers: this.bridge.headers(), body: JSON.stringify(payload), signal });
    if (!response.ok) {
      let message = `连接失败（${response.status}）`;
      try { const data = await response.json(); message = upstreamError(data) || data.message || message; } catch {}
      throw new Error(message);
    }
    return response;
  }
  async models(profile, signal) {
    const result = await this.resolve(profile, signal, true);
    return result.models;
  }
  async turn(profile, messages, { signal, tools = [], onText, onSummary, onUsage } = {}) {
    if (!profile.model?.trim()) throw new Error('请先配置主持模型。');
    const resolved = await this.resolve(profile, signal);
    const payload = { ...connectionPayload({ ...profile, baseUrl: resolved.baseUrl }), model: profile.model.trim(), messages,
      stream: true, max_tokens: Number(profile.maxTokens) || 4096, temperature: Number(profile.temperature ?? 0.7),
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}), ...(profile.protocol !== 'openai' ? { use_sysprompt: true } : {}) };
    const wire = await inspectWire(await this.post('/api/backends/chat-completions/generate', payload, signal), signal);
    const result = { text: '', summary: '', tools: [], usage: null, finishReason: '' }, calls = new Map();
    let completed = false;
    const call = (index, value, full = false) => {
      const old = calls.get(index) || { id: value.id || `call_${crypto.randomUUID().replaceAll('-','')}`, type: 'function', function: { name: '', arguments: '' } };
      if (value.id) old.id = value.id;
      if (value.function?.name) old.function.name = full ? value.function.name : old.function.name + value.function.name;
      if (value.function?.arguments) old.function.arguments = full ? value.function.arguments : old.function.arguments + value.function.arguments;
      calls.set(index, old);
    };
    const event = data => {
      const error = upstreamError(data); if (error) throw new Error(error);
      if (data.usage || data.usageMetadata || data.message?.usage) { result.usage = { ...result.usage, ...(data.usage || data.usageMetadata || data.message.usage) }; onUsage?.(result.usage); }
      const choice = data.choices?.[0], message = choice?.message, delta = choice?.delta;
      let text = delta?.content || message?.content || '';
      for (const t of delta?.tool_calls || []) call(t.index ?? 0, t);
      (message?.tool_calls || []).forEach((t,i)=>call(i,t,true));
      if (data.type === 'content_block_start') {
        const b=data.content_block;
        if(b?.type==='tool_use') call(data.index,{id:b.id,function:{name:b.name,arguments:Object.keys(b.input||{}).length?JSON.stringify(b.input):''}},true);
        if(b?.type==='text')text+=b.text||'';
      }
      if(data.delta?.type==='text_delta')text+=data.delta.text||'';
      if(data.delta?.type==='input_json_delta')call(data.index,{function:{arguments:data.delta.partial_json||''}});
      if(Array.isArray(data.content))data.content.forEach((b,i)=>{if(b.type==='text')text+=b.text||'';if(b.type==='tool_use')call(i,{id:b.id,function:{name:b.name,arguments:JSON.stringify(b.input)}},true);});
      for(const [i,p]of (data.candidates?.[0]?.content?.parts||[]).entries()) {
        if(p.text&&!p.thought)text+=p.text;
        if(p.functionCall)call(i,{id:p.functionCall.id,function:{name:p.functionCall.name,arguments:JSON.stringify(p.functionCall.args||{})}},true);
      }
      // Only explicitly exposed reasoning summaries are displayed; hidden reasoning is not synthesized.
      const summary=delta?.reasoning_summary || data.reasoning_summary || (data.type==='response.reasoning_summary_text.delta'?data.delta:'');
      if(typeof summary==='string'&&summary){result.summary+=summary;onSummary?.(result.summary);}
      if(text){result.text+=text;onText?.(result.text);}
      const reason=choice?.finish_reason||data.delta?.stop_reason||data.stop_reason||data.candidates?.[0]?.finishReason;
      if(reason){result.finishReason=reason;completed=true;if(['length','MAX_TOKENS','max_tokens'].includes(reason))throw new Error('达到回复上限，本步骤未完成，可重试继续。');}
      if(data.type==='message_stop')completed=true;
    };
    try { if(wire.json){event(await wire.response.json());completed=true;}else await readSse(wire.response,event,signal,()=>{completed=true;}); }
    catch(error){error.partial=result.text;throw error;}
    signal?.throwIfAborted();result.tools=[...calls.values()];
    if(!completed)throw Object.assign(new Error('模型连接在步骤结束前中断，检查点已保留。'),{partial:result.text});
    if(!result.text.trim()&&!result.tools.length)throw new Error('模型未返回正文或工具调用。');
    return result;
  }
  async resolve(profile, signal, strict = false) {
    const payload = connectionPayload(profile), base = payload.reverse_proxy;
    const identity = JSON.stringify([profile.protocol, base, profile.apiKey || '']);
    if (this.resolutions.has(identity)) return this.resolutions.get(identity);
    const candidates = [base];
    if (profile.protocol === 'openai' && new URL(base).pathname === '/') candidates.unshift(`${base}/v1`);
    let lastError;
    for (const candidate of candidates) {
      try {
        const response = await this.post('/api/backends/chat-completions/status', { ...payload, reverse_proxy: candidate }, signal);
        const data = await response.json(); const error = upstreamError(data); if (error) throw new Error(error);
        const result = { baseUrl: candidate, models: extractModels(data), metadata: {} };
        for(const m of (Array.isArray(data)?data:data.data||data.models||[]))if(typeof m==='object'){const id=m.id||m.name?.replace(/^models\//,'');const limit=Number(m.context_length||m.context_window||m.inputTokenLimit);if(id&&limit>0)result.metadata[id]={contextWindow:limit,source:'接口 /models 元数据'};}
        if (!result.models.length) throw new Error('没有找到可用模型。');
        this.resolutions.set(identity, result);
        return result;
      } catch (error) { signal?.throwIfAborted(); lastError = error; }
    }
    if (strict) throw new Error(`未能读取模型列表。请检查 API 地址和密钥，也可手动填写模型。${lastError?.message ? ` ${lastError.message}` : ''}`);
    // Model-list endpoints are optional. Never retry a generation against a guessed URL.
    return { baseUrl: base, models: [] };
  }
  async chat(profile, messages, { signal, onText } = {}) {
    if (!profile.model?.trim()) throw new Error('请先选择或填写主持模型。');
    const resolved = await this.resolve(profile, signal);
    const payload = { ...connectionPayload({ ...profile, baseUrl: resolved.baseUrl }), model: profile.model.trim(), messages, stream: true,
      max_tokens: Number(profile.maxTokens) || 4096, temperature: Number(profile.temperature ?? 0.7) };
    if (profile.protocol !== 'openai') payload.use_sysprompt = true;
    const wire = await inspectWire(await this.post('/api/backends/chat-completions/generate', payload, signal), signal);
    const response = wire.response;
    let content = '', completed = false;
    if (!wire.json) {
      try { await readSse(response, data => {
        const error = upstreamError(data); if (error) throw new Error(error);
        const choice = data.choices?.[0];
        const delta = choice?.delta?.content ?? data.delta?.text ?? data.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('') ?? '';
        if (delta) { content += delta; onText?.(content); }
        const reason = choice?.finish_reason || data.candidates?.[0]?.finishReason || data.delta?.stop_reason;
        if (['length', 'MAX_TOKENS', 'max_tokens'].includes(reason)) throw new Error('达到最大回复 Token，内容尚未写完。请提高上限后重试。');
        if (['content_filter', 'SAFETY', 'RECITATION'].includes(reason)) throw new Error('模型服务中止了本次回复，请检查返回内容后重试。');
        if (reason || data.type === 'message_stop') completed = true;
      }, signal, () => { completed = true; }); }
      catch (error) { if (content) error.partial = content; throw error; }
    } else { content = extractText(await response.json(), profile.protocol); completed = true; onText?.(content); }
    signal?.throwIfAborted();
    if (!content.trim()) throw new Error('模型没有返回正文，请检查模型和连接配置。');
    if (!completed) throw Object.assign(new Error('连接在回复结束前中断，已收到的内容已保留。'), { partial: content });
    return content;
  }
}
