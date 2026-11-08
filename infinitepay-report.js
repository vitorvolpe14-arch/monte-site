// Lê o "Relatório de Vendas" que o app da InfinitePay exporta em PDF e devolve as transações.
// Roda no navegador (painel) e no Node (testes), sem biblioteca externa: o PDF da InfinitePay
// guarda o texto em fluxos comprimidos (FlateDecode) com fontes que trazem o mapa ToUnicode.
// Nada sai do aparelho aqui: o painel só envia ao servidor as linhas já lidas.
(function (root) {
    "use strict";

    // ---------- Leitura do PDF ----------

    const WS = new Set([0, 9, 10, 12, 13, 32]);
    const DELIM = new Set("()<>[]{}/%".split("").map(c => c.charCodeAt(0)));

    function latin1(bytes) {
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return s;
    }

    function bytesOf(str) {
        const out = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
        return out;
    }

    async function inflate(bytes) {
        if (typeof DecompressionStream !== "function") throw new Error("Este navegador não consegue abrir o PDF. Atualize o navegador e tente de novo.");
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    // Leitor de objetos PDF (números, nomes, textos, listas, dicionários e referências "n 0 R").
    function Lexer(str, pos) { this.s = str; this.p = pos || 0; }
    Lexer.prototype.skip = function () {
        const s = this.s;
        while (this.p < s.length) {
            const c = s.charCodeAt(this.p);
            if (WS.has(c)) { this.p++; continue; }
            if (c === 37) { while (this.p < s.length && s[this.p] !== "\n" && s[this.p] !== "\r") this.p++; continue; }
            break;
        }
    };
    Lexer.prototype.token = function () {
        this.skip();
        const s = this.s;
        if (this.p >= s.length) return null;
        const c = s[this.p];
        if (c === "/") {
            let e = this.p + 1;
            while (e < s.length && !WS.has(s.charCodeAt(e)) && !DELIM.has(s.charCodeAt(e))) e++;
            const raw = s.slice(this.p + 1, e);
            this.p = e;
            return { t: "name", v: raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) };
        }
        if (c === "(") return { t: "str", v: this.literal() };
        if (c === "<") {
            if (s[this.p + 1] === "<") { this.p += 2; return { t: "<<" }; }
            const e = s.indexOf(">", this.p);
            if (e < 0) throw new Error("PDF incompleto.");
            let hex = s.slice(this.p + 1, e).replace(/[^0-9a-fA-F]/g, "");
            this.p = e + 1;
            if (hex.length % 2) hex += "0";
            let v = "";
            for (let i = 0; i < hex.length; i += 2) v += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
            return { t: "str", v };
        }
        if (c === ">" && s[this.p + 1] === ">") { this.p += 2; return { t: ">>" }; }
        if (c === "[" || c === "]" || c === "{" || c === "}") { this.p++; return { t: c }; }
        let e = this.p;
        while (e < s.length && !WS.has(s.charCodeAt(e)) && !DELIM.has(s.charCodeAt(e))) e++;
        if (e === this.p) { this.p++; return { t: "op", v: c }; }
        const w = s.slice(this.p, e);
        this.p = e;
        if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return { t: "num", v: parseFloat(w) };
        return { t: "op", v: w };
    };
    Lexer.prototype.literal = function () {
        const s = this.s;
        let depth = 0, out = "";
        this.p++;
        while (this.p < s.length) {
            const c = s[this.p++];
            if (c === "\\") {
                const n = s[this.p++];
                const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
                if (map[n]) out += map[n];
                else if (n >= "0" && n <= "7") {
                    let oct = n;
                    while (oct.length < 3 && s[this.p] >= "0" && s[this.p] <= "7") oct += s[this.p++];
                    out += String.fromCharCode(parseInt(oct, 8) & 0xff);
                } else if (n === "\r") { if (s[this.p] === "\n") this.p++; }
                else if (n !== "\n") out += n;
                continue;
            }
            if (c === "(") depth++;
            if (c === ")") { if (depth === 0) break; depth--; }
            out += c;
        }
        return out;
    };
    // Lê um valor completo; "n g R" vira referência.
    Lexer.prototype.value = function (tok) {
        tok = tok || this.token();
        if (!tok) return null;
        if (tok.t === "<<") {
            const d = {};
            for (;;) {
                const k = this.token();
                if (!k || k.t === ">>") break;
                if (k.t !== "name") continue;
                d[k.v] = this.value();
            }
            return { dict: d };
        }
        if (tok.t === "[") {
            const a = [];
            for (;;) {
                const t = this.token();
                if (!t || t.t === "]") break;
                a.push(this.value(t));
            }
            return a;
        }
        if (tok.t === "num") {
            const save = this.p;
            const g = this.token();
            if (g && g.t === "num") {
                const r = this.token();
                if (r && r.t === "op" && r.v === "R") return { ref: tok.v };
            }
            this.p = save;
            return tok.v;
        }
        if (tok.t === "name") return { name: tok.v };
        if (tok.t === "str") return { str: tok.v };
        if (tok.t === "op") return tok.v === "true" ? true : tok.v === "false" ? false : null;
        return null;
    };

    // Encontra os objetos "n g obj ... endobj" e seus fluxos de dados.
    function readObjects(str) {
        const smallNumbers = new Map();
        const numRe = /(\d+)\s+\d+\s+obj\s*(\d+)\s*endobj/g;
        let m;
        while ((m = numRe.exec(str))) smallNumbers.set(+m[1], +m[2]);
        const objects = new Map();
        const re = /(\d+)\s+(\d+)\s+obj\b/g;
        while ((m = re.exec(str))) {
            const num = +m[1];
            const lx = new Lexer(str, re.lastIndex);
            let value;
            try { value = lx.value(); } catch (_) { continue; }
            const entry = { value };
            lx.skip();
            if (value && value.dict && str.startsWith("stream", lx.p)) {
                let start = lx.p + 6;
                if (str[start] === "\r") start++;
                if (str[start] === "\n") start++;
                let len = value.dict.Length;
                if (len && len.ref !== undefined) len = smallNumbers.get(len.ref);
                let end = typeof len === "number" && start + len <= str.length ? start + len : -1;
                if (end < 0 || !/^\s*endstream/.test(str.slice(end, end + 20))) {
                    end = str.indexOf("endstream", start);
                    if (end < 0) end = str.length;
                    while (end > start && (str[end - 1] === "\n" || str[end - 1] === "\r")) end--;
                }
                entry.stream = [start, end];
                re.lastIndex = end;
            }
            objects.set(num, entry);
        }
        return objects;
    }

    function PdfDoc(bytes) {
        this.str = latin1(bytes);
        if (!this.str.startsWith("%PDF")) throw new Error("O arquivo escolhido não é um PDF.");
        this.objects = readObjects(this.str);
        this.cache = new Map();
    }
    PdfDoc.prototype.get = function (v) {
        let guard = 0;
        while (v && v.ref !== undefined && guard++ < 20) {
            const o = this.objects.get(v.ref);
            v = o ? o.value : null;
        }
        return v;
    };
    PdfDoc.prototype.dict = function (v) { const d = this.get(v); return d && d.dict ? d.dict : {}; };
    PdfDoc.prototype.streamOf = async function (ref) {
        if (!ref || ref.ref === undefined) return "";
        if (this.cache.has(ref.ref)) return this.cache.get(ref.ref);
        const o = this.objects.get(ref.ref);
        if (!o || !o.stream) return "";
        const d = o.value.dict;
        let raw = bytesOf(this.str.slice(o.stream[0], o.stream[1]));
        let filters = this.get(d.Filter);
        filters = Array.isArray(filters) ? filters.map(f => this.get(f)) : filters ? [filters] : [];
        for (const f of filters) {
            if (f.name === "FlateDecode" || f.name === "Fl") raw = await inflate(raw);
            else throw new Error("Este PDF usa um formato que o painel não lê (" + f.name + ").");
        }
        const out = latin1(raw);
        this.cache.set(ref.ref, out);
        return out;
    };
    PdfDoc.prototype.pages = function () {
        const trailerRoot = /\/Root\s+(\d+)\s+\d+\s+R/.exec(this.str);
        let rootRef = trailerRoot ? { ref: +trailerRoot[1] } : null;
        if (!rootRef) {
            for (const [num, o] of this.objects) {
                const t = o.value && o.value.dict && this.get(o.value.dict.Type);
                if (t && t.name === "Catalog") { rootRef = { ref: num }; break; }
            }
        }
        const out = [];
        const walk = (ref, inherited, depth) => {
            if (depth > 30) return;
            const node = this.dict(ref);
            const res = node.Resources !== undefined ? node.Resources : inherited;
            const type = this.get(node.Type);
            if (type && type.name === "Pages") {
                for (const kid of this.get(node.Kids) || []) walk(kid, res, depth + 1);
            } else if (type && type.name === "Page") {
                out.push({ dict: node, resources: res });
            }
        };
        if (rootRef) walk(this.dict(rootRef).Pages, undefined, 0);
        return out;
    };

    function utf16(str) {
        let s = "";
        for (let i = 0; i + 1 < str.length; i += 2) s += String.fromCharCode((str.charCodeAt(i) << 8) | str.charCodeAt(i + 1));
        return s;
    }

    function hexToInt(str) {
        let n = 0;
        for (let i = 0; i < str.length; i++) n = n * 256 + str.charCodeAt(i);
        return n;
    }

    // Mapa ToUnicode: código do glifo → texto.
    function parseCMap(text) {
        const map = new Map();
        let bytes = 1;
        const lx = new Lexer(text);
        const vals = [];
        for (;;) {
            const tok = lx.token();
            if (!tok) break;
            if (tok.t === "op") {
                if (tok.v === "endcodespacerange") {
                    const lo = vals.find(v => v && v.str !== undefined);
                    if (lo) bytes = Math.max(1, lo.str.length);
                } else if (tok.v === "endbfchar") {
                    for (let i = 0; i + 1 < vals.length; i += 2) {
                        if (vals[i] && vals[i].str !== undefined && vals[i + 1] && vals[i + 1].str !== undefined) {
                            map.set(hexToInt(vals[i].str), utf16(vals[i + 1].str));
                        }
                    }
                } else if (tok.v === "endbfrange") {
                    for (let i = 0; i + 2 < vals.length; i += 3) {
                        const lo = vals[i], hi = vals[i + 1], dst = vals[i + 2];
                        if (!lo || lo.str === undefined || !hi || hi.str === undefined) continue;
                        const a = hexToInt(lo.str), b = hexToInt(hi.str);
                        if (b < a || b - a > 65535) continue;
                        if (Array.isArray(dst)) {
                            for (let c = a; c <= b && c - a < dst.length; c++) if (dst[c - a] && dst[c - a].str !== undefined) map.set(c, utf16(dst[c - a].str));
                        } else if (dst && dst.str !== undefined) {
                            const base = utf16(dst.str);
                            const last = base.charCodeAt(base.length - 1);
                            for (let c = a; c <= b; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - a)));
                        }
                    }
                }
                vals.length = 0;
                continue;
            }
            vals.push(lx.value(tok));
        }
        return { map, bytes };
    }

    async function loadFont(doc, ref) {
        const font = doc.dict(ref);
        const enc = doc.get(font.Encoding);
        const twoBytes = !!(enc && enc.name && /Identity-[HV]|UCS2|UTF16/.test(enc.name));
        let cmap = null;
        if (font.ToUnicode) {
            const text = await doc.streamOf(font.ToUnicode);
            if (text) cmap = parseCMap(text);
        }
        const bytes = cmap ? cmap.bytes : twoBytes ? 2 : 1;
        return {
            decode(str) {
                let out = "";
                for (let i = 0; i + bytes <= str.length; i += bytes) {
                    const code = hexToInt(str.slice(i, i + bytes));
                    if (cmap && cmap.map.has(code)) out += cmap.map.get(code);
                    else if (!cmap && bytes === 1) out += String.fromCharCode(code);
                }
                return out;
            }
        };
    }

    const mul = (a, b) => [
        a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]
    ];

    // Executa o conteúdo da página e devolve os trechos de texto com a posição (x, y de cima para baixo).
    async function pageRuns(doc, page) {
        const res = doc.dict(page.resources);
        const fontDict = doc.dict(res.Font);
        const fonts = {};
        for (const name of Object.keys(fontDict)) fonts[name] = await loadFont(doc, fontDict[name]);
        const contents = doc.get(page.dict.Contents);
        const refs = Array.isArray(contents) ? contents : page.dict.Contents ? [page.dict.Contents] : [];
        let text = "";
        for (const r of refs) text += (await doc.streamOf(r)) + "\n";
        const box = doc.get(page.dict.MediaBox) || [0, 0, 595, 842];
        const height = (doc.get(box[3]) || 842);

        const runs = [];
        let ctm = [1, 0, 0, 1, 0, 0];
        const stack = [];
        let tm = [1, 0, 0, 1, 0, 0], tlm = tm, font = null, size = 0, leading = 0;
        let cur = null;
        const flush = () => { if (cur && cur.s.trim()) runs.push(cur); cur = null; };
        const show = (str) => {
            if (!font) return;
            const t = font.decode(str);
            if (!t) return;
            const m = mul(tm, ctm);
            const x = m[4], y = height - m[5];
            const fs = Math.abs(size * (m[3] || m[0] || 1));
            if (cur && Math.abs(cur.y - y) < Math.max(1, fs * 0.3) && x >= cur.lastX - 0.5) {
                cur.s += t; cur.lastX = x;
            } else {
                flush();
                cur = { x, y, s: t, lastX: x, size: fs };
            }
        };
        const lx = new Lexer(text);
        const ops = [];
        for (;;) {
            const tok = lx.token();
            if (!tok) break;
            if (tok.t !== "op") { ops.push(lx.value(tok)); continue; }
            const op = tok.v;
            const n = i => (typeof ops[i] === "number" ? ops[i] : 0);
            switch (op) {
                case "q": stack.push(ctm); break;
                case "Q": if (stack.length) ctm = stack.pop(); break;
                case "cm": if (ops.length >= 6) ctm = mul(ops.slice(-6).map(v => (typeof v === "number" ? v : 0)), ctm); break;
                case "BT": flush(); tm = tlm = [1, 0, 0, 1, 0, 0]; break;
                case "ET": flush(); break;
                case "Tf": {
                    const nm = ops[ops.length - 2];
                    font = nm && nm.name ? fonts[nm.name] || null : null;
                    size = typeof ops[ops.length - 1] === "number" ? ops[ops.length - 1] : 0;
                    break;
                }
                case "TL": leading = n(ops.length - 1); break;
                case "Tm": if (ops.length >= 6) tm = tlm = ops.slice(-6).map(v => (typeof v === "number" ? v : 0)); break;
                case "Td": case "TD": {
                    const tx = n(ops.length - 2), ty = n(ops.length - 1);
                    if (op === "TD") leading = -ty;
                    tm = tlm = mul([1, 0, 0, 1, tx, ty], tlm);
                    break;
                }
                case "T*": tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm); break;
                case "Tj": { const s = ops[ops.length - 1]; if (s && s.str !== undefined) show(s.str); break; }
                case "'": case "\"": {
                    tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
                    const s = ops[ops.length - 1]; if (s && s.str !== undefined) show(s.str);
                    break;
                }
                case "TJ": {
                    const arr = ops[ops.length - 1];
                    if (Array.isArray(arr)) {
                        let s = "";
                        for (const part of arr) {
                            if (part && part.str !== undefined) s += part.str;
                            else if (typeof part === "number" && part < -200) { if (s) show(s); s = ""; if (cur && !cur.s.endsWith(" ")) cur.s += " "; }
                        }
                        if (s) show(s);
                    }
                    break;
                }
                case "BI": {
                    const e = text.indexOf("EI", lx.p);
                    lx.p = e < 0 ? text.length : e + 2;
                    break;
                }
                default: break;
            }
            ops.length = 0;
        }
        flush();
        return runs.map(r => ({ x: r.x, y: r.y, s: r.s, size: r.size }));
    }

    async function extractText(bytes) {
        const doc = new PdfDoc(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        const info = /\/CreationDate\s*\((?:\xfe\xff)?((?:\x00?[D:0-9+\-Z'])+)\)/.exec(doc.str);
        const pages = doc.pages();
        if (!pages.length) throw new Error("Não encontrei as páginas deste PDF.");
        const out = [];
        for (let i = 0; i < pages.length; i++) out.push(await pageRuns(doc, pages[i]));
        return { pages: out, created: info ? info[1].replace(/\x00/g, "") : "" };
    }

    // ---------- Leitura do relatório ----------

    const MONTHS = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
    const STATUS = ["Aprovada", "Cancelada", "Negada", "Estornada", "Pendente", "Contestada", "Recusada", "Expirada", "Chargeback", "Em análise"];
    const TYPES = ["Link de Pagamento", "Link Integrado", "Conta Inteligente", "InfiniteTap", "Cobrança", "Maquininha", "Tap to Pay", "Smart"];
    const MEIOS = ["Crédito", "Débito", "Pix", "Boleto", "Dinheiro"];
    const clean = s => String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim();
    const money = s => Math.round(parseFloat(String(s).replace(/\./g, "").replace(",", ".")) * 100) / 100;

    // Data do PDF (D:20261104225707Z ou com fuso) → ISO.
    function pdfDate(s) {
        const m = /D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(s || "");
        if (!m) return null;
        let tz = "Z";
        if (m[7] && m[7] !== "Z") tz = m[7].replace(/'/g, "").replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
        const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}${tz}`;
        const t = Date.parse(iso);
        return Number.isFinite(t) ? new Date(t).toISOString() : null;
    }

    function parseReport(extracted) {
        const pages = extracted.pages;
        const rows = [];
        const summary = { from: null, to: null, total: null, fees: null, net: null, created: pdfDate(extracted.created) };
        const unread = [];
        pages.forEach((runs, pi) => {
            const items = runs.map(r => ({ x: r.x, y: r.y, s: clean(r.s) })).filter(r => r.s);
            for (const r of items) {
                let m;
                if (!summary.from && (m = /^(\d{2})\/(\d{2})\/(\d{4}) - (\d{2})\/(\d{2})\/(\d{4})$/.exec(r.s))) {
                    summary.from = `${m[3]}-${m[2]}-${m[1]}`;
                    summary.to = `${m[6]}-${m[5]}-${m[4]}`;
                }
                if ((m = /^Total em vendas R\$ ([\d.]+,\d{2})$/.exec(r.s))) summary.total = money(m[1]);
                if ((m = /^Total em taxas aplicadas R\$ ([\d.]+,\d{2})$/.exec(r.s))) summary.fees = money(m[1]);
                if ((m = /^Total a receber no período R\$ ([\d.]+,\d{2})$/.exec(r.s))) summary.net = money(m[1]);
            }
            // Os totais podem vir em trechos separados ("Total em taxas aplicadas" | "R$ 12.917,26").
            const label = (re) => {
                const l = items.find(r => re.test(r.s));
                if (!l) return null;
                const v = items.filter(r => Math.abs(r.y - l.y) < 4 && r.x > l.x && /^R\$ [\d.]+,\d{2}$/.test(r.s)).sort((a, b) => a.x - b.x)[0];
                return v ? money(v.s.slice(3)) : null;
            };
            if (summary.fees === null) summary.fees = label(/^Total em taxas aplicadas$/);
            if (summary.net === null) summary.net = label(/^Total a receber no período$/);
            if (summary.total === null) summary.total = label(/^Total em vendas$/);

            const head = items.find(r => r.s === "Data e hora");
            if (!head) return;
            const col = name => {
                const h = items.find(r => Math.abs(r.y - head.y) < 4 && r.s.startsWith(name));
                return h ? h.x : null;
            };
            const cx = { meio: col("Meio"), tipo: col("Tipo"), id: col("Identificador"), status: col("Status"), valor: col("Valor"), liq: col("Líquido"), taxa: col("Taxa"), plano: col("Plano") };
            if (Object.values(cx).some(v => v === null)) return;
            const footer = items.find(r => /^A Central de Ajuda/.test(r.s));
            const bottom = footer ? footer.y : Infinity;
            const body = items.filter(r => r.y > head.y + 2 && r.y < bottom - 2);
            const anchors = body.filter(r => STATUS.includes(r.s) && r.x >= cx.status - 4 && r.x < cx.valor - 4).sort((a, b) => a.y - b.y);
            if (!anchors.length) return;
            const gaps = anchors.slice(1).map((a, i) => a.y - anchors[i].y).sort((a, b) => a - b);
            const reach = gaps.length ? gaps[Math.floor(gaps.length / 2)] * 0.75 : 40;
            const groups = anchors.map(a => ({ anchor: a, parts: [] }));
            for (const r of body) {
                if (anchors.includes(r)) continue;
                let best = null, bestD = Infinity;
                for (const g of groups) {
                    const d = Math.abs(r.y - g.anchor.y);
                    if (d < bestD) { best = g; bestD = d; }
                }
                if (best && bestD <= reach) best.parts.push(r);
            }
            for (const g of groups) {
                const row = readRow(g, cx);
                if (row.error) unread.push({ page: pi + 1, error: row.error, text: g.parts.map(p => p.s).join(" | ").slice(0, 160) });
                else rows.push(row);
            }
        });
        return { rows, summary, unread };
    }

    function readRow(g, cx) {
        const parts = g.parts.slice().sort((a, b) => a.y - b.y || a.x - b.x);
        const inCol = (from, to) => parts.filter(p => p.x >= from - 4 && p.x < to - 4);
        const dateText = inCol(-Infinity, cx.meio).map(p => p.s).join(" ");
        const d = /(\d{2}) (Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez),? (\d{4})/i.exec(dateText);
        const t = /\b(\d{2}):(\d{2})\b/.exec(dateText);
        if (!d) return { error: "sem data" };
        const meioCol = inCol(cx.meio, cx.tipo).map(p => p.s);
        const meio = meioCol.find(s => MEIOS.includes(s)) || null;
        let parcelas = 1;
        const inst = meioCol.map(s => /^(\d{1,2})x$/i.exec(s)).find(Boolean);
        if (inst) parcelas = +inst[1];
        const tipoCol = inCol(cx.tipo, cx.id).map(p => p.s);
        const tipo = tipoCol.find(s => TYPES.includes(s)) || (tipoCol[0] || "").slice(0, 40) || null;
        const ident = inCol(cx.id, cx.status).map(p => p.s).find(s => /^[A-Za-z0-9-]{3,64}$/.test(s)) || null;
        const amounts = parts.filter(p => /^[+-] ?[\d.]+,\d{2}$/.test(p.s)).sort((a, b) => a.x - b.x);
        if (amounts.length < 2) return { error: "sem valor" };
        const signed = s => (s.trim()[0] === "-" ? -1 : 1) * money(s.replace(/^[+-] ?/, ""));
        const valor = signed(amounts[0].s), liquido = signed(amounts[1].s);
        const rest = parts.filter(p => p.x >= cx.taxa - 40 && !amounts.includes(p)).map(p => p.s).join(" ");
        const fee = /R\$ ?- ?([\d.]+,\d{2})/.exec(rest);
        const pct = /\((\d+(?:[.,]\d+)?)%\)/.exec(rest);
        const plano = (/(\d+ Dias? Út(?:il|eis)|\d+ Dias?|Na hora|Outro)/i.exec(rest) || [])[1] || null;
        return {
            data: `${d[3]}-${String(MONTHS[d[2].toLowerCase()]).padStart(2, "0")}-${d[1]}`,
            hora: t ? `${t[1]}:${t[2]}` : null,
            meio, tipo, identificador: ident, parcelas,
            status: g.anchor.s,
            valor, liquido,
            taxa: fee ? money(fee[1]) : Math.round((valor - liquido) * 100) / 100,
            taxa_percentual: pct ? parseFloat(pct[1].replace(",", ".")) : null,
            plano
        };
    }

    // Confere a leitura com os totais do próprio relatório (soma das aprovadas).
    function checkReport(report) {
        const ok = report.rows.filter(r => r.status === "Aprovada");
        const sum = k => Math.round(ok.reduce((a, r) => a + r[k] * 100, 0)) / 100;
        const got = { total: sum("valor"), fees: sum("taxa"), net: sum("liquido") };
        const s = report.summary;
        const same = (a, b) => a === null || Math.abs(a - b) < 0.005;
        return {
            ok: report.rows.length > 0 && !report.unread.length && s.total !== null && same(s.total, got.total) && same(s.fees, got.fees) && same(s.net, got.net),
            approved: ok.length,
            got,
            expected: { total: s.total, fees: s.fees, net: s.net }
        };
    }

    async function readInfinitePayReport(bytes) {
        const report = parseReport(await extractText(bytes));
        report.check = checkReport(report);
        return report;
    }

    // Linhas idênticas no mesmo relatório (mesmo dia, hora, valor...) ganham um número de ordem,
    // para cada uma ter a sua chave no banco.
    function numberRows(rows) {
        const seen = new Map();
        return rows.map(r => {
            const base = [r.data, r.hora || "", r.tipo || "", r.meio || "", r.parcelas, Number(r.valor).toFixed(2), r.identificador || ""].join("|");
            const n = seen.get(base) || 0;
            seen.set(base, n + 1);
            return { ...r, n };
        });
    }

    // ---------- Relatório de movimentações (extrato da conta) ----------
    // O extrato mostra o que entrou e saiu do saldo: depósitos das vendas no cartão, Pix
    // recebidos e enviados, fatura do cartão de crédito, boletos... Daí sai o que fica na conta
    // depois dos pagamentos feitos com o saldo. A coluna "Nome" (quem pagou ou recebeu) não é
    // lida: só data, hora, tipo, detalhe e valor.

    const MONTH_DATE = /(\d{2}) (Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez),? (\d{4})/i;
    const ymdOf = m => `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, "0")}-${m[1]}`;
    // "+528,01", "-8.512,52", "+ 4.099,03" e também "--R$ 25,00" (assim sai a fatura do cartão).
    const STATEMENT_AMOUNT = /^([+-]{1,2}) ?(?:R\$ ?)?([\d.]+,\d{2})$/;
    const statementAmount = s => {
        const m = STATEMENT_AMOUNT.exec(String(s).trim());
        return m ? (m[1].includes("-") ? -1 : 1) * money(m[2]) : null;
    };

    const isStatement = extracted => extracted.pages.some(runs => runs.some(r => clean(r.s) === "Relatório de movimentações"));

    function parseStatement(extracted) {
        const rows = [];
        const summary = { from: null, to: null, created: pdfDate(extracted.created), opening: null, inflow: null, outflow: null, closing: null };
        const unread = [];
        let day = null;
        extracted.pages.forEach((runs, pi) => {
            const items = runs.map(r => ({ x: r.x, y: r.y, s: clean(r.s) })).filter(r => r.s);
            for (const r of items) {
                const m = /^(\d{2} \S+,? \d{4}) - (\d{2} \S+,? \d{4})$/.exec(r.s);
                if (!summary.from && m && MONTH_DATE.test(m[1]) && MONTH_DATE.test(m[2])) {
                    summary.from = ymdOf(MONTH_DATE.exec(m[1]));
                    summary.to = ymdOf(MONTH_DATE.exec(m[2]));
                }
            }
            // Os totais: o rótulo e, na mesma linha à direita, o valor com sinal, sem outro texto no
            // meio ("Saldo final do período" também aparece à esquerda, na linha do "Saldo inicial").
            const total = label => {
                for (const l of items.filter(r => r.s === label)) {
                    const row = items.filter(r => Math.abs(r.y - l.y) < 4 && r.x > l.x).sort((a, b) => a.x - b.x);
                    if (row.length && statementAmount(row[0].s) !== null) return statementAmount(row[0].s);
                }
                return null;
            };
            if (summary.opening === null) summary.opening = total("Saldo inicial");
            if (summary.inflow === null) summary.inflow = total("Total de entradas");
            if (summary.outflow === null) { const v = total("Total de saídas"); summary.outflow = v === null ? null : Math.abs(v); }
            if (summary.closing === null) summary.closing = total("Saldo final do período");

            // Cada dia tem o seu cabeçalho (Data | Hora | Tipo de transação | Nome | Detalhe | Valor).
            const heads = items.filter(r => r.s === "Data" && items.some(h => Math.abs(h.y - r.y) < 4 && h.s === "Tipo de transação"));
            if (!heads.length) return;
            const head = heads[0];
            const col = name => {
                const h = items.find(r => Math.abs(r.y - head.y) < 4 && r.s.startsWith(name));
                return h ? h.x : null;
            };
            const cx = { hora: col("Hora"), tipo: col("Tipo de transação"), nome: col("Nome"), detalhe: col("Detalhe"), valor: col("Valor") };
            if (Object.values(cx).some(v => v === null)) return;
            const footer = items.find(r => /^A Central de Ajuda/.test(r.s));
            const bottom = footer ? footer.y : Infinity;
            const skipRows = items.filter(r => r.s === "Saldo do dia").concat(heads);
            const body = items.filter(r => r.y > head.y + 2 && r.y < bottom - 2 && !skipRows.some(k => Math.abs(k.y - r.y) < 4));
            // Uma movimentação por valor na coluna "Valor".
            const anchors = body.filter(r => r.x >= cx.detalhe + 40 && statementAmount(r.s) !== null).sort((a, b) => a.y - b.y);
            if (!anchors.length) return;
            const gaps = anchors.slice(1).map((a, i) => a.y - anchors[i].y).sort((a, b) => a - b);
            const reach = gaps.length ? gaps[Math.floor(gaps.length / 2)] * 0.75 : 18;
            const groups = anchors.map(a => ({ anchor: a, parts: [] }));
            for (const r of body) {
                if (anchors.includes(r)) continue;
                let best = null, bestD = Infinity;
                for (const g of groups) {
                    const d = Math.abs(r.y - g.anchor.y);
                    if (d < bestD) { best = g; bestD = d; }
                }
                if (best && bestD <= reach) best.parts.push(r);
            }
            for (const g of groups) {
                const parts = g.parts.slice().sort((a, b) => a.y - b.y || a.x - b.x);
                const inCol = (from, to) => parts.filter(p => p.x >= from - 4 && p.x < to - 4).map(p => p.s);
                // A data só vem na primeira movimentação do dia; as outras são do mesmo dia.
                const d = MONTH_DATE.exec(inCol(-Infinity, cx.hora).join(" "));
                if (d) day = ymdOf(d);
                const t = /^(\d{2}):(\d{2})$/.exec(inCol(cx.hora, cx.tipo).find(s => /^\d{2}:\d{2}$/.test(s)) || "");
                const tipo = inCol(cx.tipo, cx.nome).join(" ").slice(0, 60);
                const detalhe = inCol(cx.detalhe, cx.valor - 30).join(" ").slice(0, 60);
                if (!day) { unread.push({ page: pi + 1, error: "sem data", text: tipo }); continue; }
                if (!tipo) { unread.push({ page: pi + 1, error: "sem tipo", text: g.anchor.s }); continue; }
                rows.push({ data: day, hora: t ? `${t[1]}:${t[2]}` : null, tipo, detalhe: detalhe || null, valor: statementAmount(g.anchor.s) });
            }
        });
        return { rows, summary, unread };
    }

    // Confere a leitura com os totais do extrato: entradas, saídas e saldo final.
    function checkStatement(st) {
        const c = v => Math.round(Number(v) * 100);
        const inflow = st.rows.filter(r => r.valor > 0).reduce((a, r) => a + c(r.valor), 0) / 100;
        const outflow = st.rows.filter(r => r.valor < 0).reduce((a, r) => a - c(r.valor), 0) / 100;
        const s = st.summary;
        const same = (a, b) => a !== null && Math.abs(a - b) < 0.005;
        const balance = s.opening !== null && s.closing !== null && Math.abs(c(s.opening) + c(inflow) - c(outflow) - c(s.closing)) < 1;
        return {
            ok: st.rows.length > 0 && !st.unread.length && !!s.from && !!s.to && same(s.inflow, inflow) && same(s.outflow, outflow) && balance,
            got: { inflow, outflow },
            expected: { inflow: s.inflow, outflow: s.outflow, opening: s.opening, closing: s.closing }
        };
    }

    // O que cada movimentação é para o painel:
    //   sale: depósito das vendas no cartão ou Pix recebido (já estão no líquido das vendas);
    //   payment: pago com o saldo (fatura do cartão, boleto, tarifa...): sai do que fica na conta;
    //   withdrawal: Pix ou transferência enviada (retirada para outra conta): não entra na conta;
    //   other: outra entrada (rendimento, estorno, TED recebida...): só aparece na lista.
    function statementKind(move) {
        const tipo = String(move.tipo || ""), detalhe = String(move.detalhe || ""), v = Number(move.valor);
        if (v > 0) return /dep[oó]sito de vendas/i.test(tipo) || (/\bpix\b/i.test(tipo) && /receb/i.test(detalhe)) ? "sale" : "other";
        return /\bpix\b|transfer|\bted\b|\bdoc\b|saque/i.test(tipo) ? "withdrawal" : "payment";
    }

    // Lê um PDF da InfinitePay: o Relatório de Vendas ou o Relatório de movimentações (extrato).
    async function readInfinitePayPdf(bytes) {
        const extracted = await extractText(bytes);
        if (isStatement(extracted)) {
            const st = parseStatement(extracted);
            st.check = checkStatement(st);
            return { kind: "statement", ...st };
        }
        const report = parseReport(extracted);
        report.check = checkReport(report);
        return { kind: "sales", ...report };
    }

    // ---------- Cruzamento com as vendas registradas ----------

    const DAY = 24 * 60 * 60 * 1000;
    const SITE_TYPE = "Link Integrado";
    const isSiteTx = tx => tx.tipo === SITE_TYPE;
    // Horário do relatório é o de Brasília.
    const txTime = tx => Date.parse(`${tx.data}T${tx.hora || "12:00"}:00-03:00`);
    const dayNumber = ymd => Math.round(Date.parse(ymd + "T12:00:00Z") / DAY);
    const cents = v => Math.round(Number(v) * 100);

    // Liga cada transação aprovada do relatório a uma venda registrada.
    // transactions: linhas do relatório (data, hora, tipo, valor).
    // sales: [{ site: true, time, amount }] pedidos do site (valor pago, com a hora exata) e
    //        [{ site: false, day: "AAAA-MM-DD", amount }] vendas da loja na Olist.
    // Regras, da mais forte para a mais fraca:
    //   site: mesmo valor e até 20 min de diferença; depois mesmo valor em até 2 dias.
    //   loja: mesmo valor no mesmo dia; mesmo valor em até 3 dias; até 5 centavos de diferença
    //         em até 3 dias; e por fim uma venda da Olist paga em duas cobranças (mesmo dia ou
    //         dia seguinte) que somam o valor dela.
    // Devolve txSale[i] (índice da venda ou -1), txKind[i] ("exato", "centavos", "dividido") e
    // saleTx[j] (lista de transações da venda j).
    function matchTransactions(transactions, sales) {
        const bySite = [new Map(), new Map()];
        sales.forEach((s, j) => {
            const m = bySite[s.site ? 1 : 0], c = cents(s.amount);
            if (!m.has(c)) m.set(c, []);
            m.get(c).push(j);
        });
        const pairs = [];
        transactions.forEach((tx, i) => {
            const site = isSiteTx(tx), m = bySite[site ? 1 : 0], c = cents(tx.valor), t = txTime(tx), day = dayNumber(tx.data);
            for (let d = site ? 0 : -5; d <= (site ? 0 : 5); d++) {
                for (const j of m.get(c + d) || []) {
                    const s = sales[j];
                    if (site) {
                        const dt = Math.abs(s.time - t);
                        if (dt <= 20 * 60 * 1000) pairs.push([0, dt, i, j]);
                        else if (dt <= 2 * DAY) pairs.push([1, dt, i, j]);
                    } else {
                        const days = Math.abs(dayNumber(s.day) - day);
                        if (days > 3) continue;
                        if (d === 0) pairs.push([days === 0 ? 0 : 1, days, i, j]);
                        else pairs.push([2, days * 10 + Math.abs(d), i, j]);
                    }
                }
            }
        });
        pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
        const txSale = transactions.map(() => -1), txKind = transactions.map(() => null), saleTx = sales.map(() => []);
        for (const [tier, , i, j] of pairs) {
            if (txSale[i] >= 0 || saleTx[j].length) continue;
            txSale[i] = j;
            txKind[i] = tier === 2 ? "centavos" : "exato";
            saleTx[j].push(i);
        }
        // Venda da loja paga em duas cobranças.
        const loose = transactions.map((tx, i) => i).filter(i => txSale[i] < 0 && !isSiteTx(transactions[i]));
        sales.forEach((s, j) => {
            if (s.site || saleTx[j].length) return;
            const target = cents(s.amount), day = dayNumber(s.day);
            const near = loose.filter(i => txSale[i] < 0 && Math.abs(dayNumber(transactions[i].data) - day) <= 1 && cents(transactions[i].valor) < target);
            for (let a = 0; a < near.length; a++) {
                for (let b = a + 1; b < near.length; b++) {
                    const ia = near[a], ib = near[b];
                    if (Math.abs(cents(transactions[ia].valor) + cents(transactions[ib].valor) - target) <= 1) {
                        txSale[ia] = txSale[ib] = j;
                        txKind[ia] = txKind[ib] = "dividido";
                        saleTx[j].push(ia, ib);
                        return;
                    }
                }
            }
        });
        return { txSale, txKind, saleTx };
    }

    const api = { extractText, parseReport, checkReport, readInfinitePayReport, numberRows, matchTransactions, isSiteTx, txTime, pdfDate, parseCMap,
        parseStatement, checkStatement, statementKind, readInfinitePayPdf };
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.InfinitePayReport = api;
})(typeof self !== "undefined" ? self : this);
