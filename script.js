/**
 * Cloudflare IP 优选工具 v2.0
 * 核心改进：使用 Image Ping（图片探测），彻底解决 HTTPS/TLS 证书问题
 * 纯前端实现，所有数据仅在浏览器本地处理
 */

// ==================== CDN / IP 库 ====================
const CF_SEEDS = {
    'china-optimized': [
        '104.16','104.17','104.18','104.19',
        '104.20','104.21','104.22','104.23',
        '104.24','104.25','104.26','104.27',
        '104.28','104.29','104.30','104.31',
        '172.64','172.65','172.66','172.67',
        '172.68','172.69','172.70','172.71',
        '141.101'
    ],
    'global': [
        '104.16','104.17','104.18','104.19',
        '104.20','104.21','104.22','104.23',
        '104.24','104.25','104.26','104.27',
        '104.28','104.29','104.30','104.31',
        '172.64','172.65','172.66','172.67',
        '172.68','172.69','172.70','172.71',
        '141.101','162.158','188.114','198.41'
    ]
};

// ==================== CIDR 工具 ====================
function ipToInt(ip) {
    const p = ip.split('.');
    return ((+p[0]<<24)|(+p[1]<<16)|(+p[2]<<8)|+p[3])>>>0;
}
function intToIp(int) {
    return `${int>>>24}.${(int>>16)&255}.${(int>>8)&255}.${int&255}`;
}
function cidrToIps(cidr) {
    const [base,bits]=cidr.split('/');
    const mask=~(2**(32-+bits)-1);
    const start=(ipToInt(base)&mask)>>>0;
    const end=start+2**(32-+bits)-1;
    const ips=[];
    for(let i=start;i<=end;i++) ips.push(intToIp(i));
    return ips;
}
function expandPreset(name) {
    const seeds=CF_SEEDS[name]||CF_SEEDS['china-optimized'];
    const ips=[];
    for(const seed of seeds) {
        const [a,b]=seed.split('.').map(Number);
        // 每个 /16 段取 64 个随机 IP
        for(let c=0;c<64;c++) {
            const d=Math.floor(Math.random()*254)+1;
            ips.push(`${a}.${b}.${c}.${d}`);
        }
    }
    return ips;
}

// ==================== Image Ping 测速引擎 ====================
// 原理：创建 <img> 标签请求 http://ip:port/xxx
// onload 和 onerror 都会触发回调——无论图片是否存在
// 测得的延迟 ≈ TCP 建连 + HTTP 往返时间（真实网络延迟）
// 完全绕过 TLS 证书不匹配和 CORS 限制
class LatencyTester {
    constructor(options={}) {
        this.domain = options.domain || 'cdn.example.com';
        this.port = options.port || 80;
        this.timeout = options.timeout || 2000;
        this.pingCount = options.pingCount || 3;
        this.concurrency = options.concurrency || 20;
        this._running = false;
        this._results = [];
    }

    /**
     * 单次 Image Ping
     * @param {string} ip
     * @returns {Promise<number>} 延迟(ms)，超时返回 Infinity
     */
    imagePingOnce(ip) {
        return new Promise((resolve) => {
            if (!this._running) return resolve(Infinity);
            const t0 = performance.now();
            const img = new Image();
            let resolved = false;

            const done = () => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                resolve(Math.round(performance.now() - t0));
            };

            const timer = setTimeout(() => {
                if (resolved) return;
                resolved = true;
                img.src = '';
                resolve(Infinity);
            }, this.timeout);

            img.onload = done;
            img.onerror = done;

            // 随机时间戳防缓存
            const ts = Date.now().toString(36) + Math.random().toString(36).slice(2,8);
            img.src = `http://${ip}:${this.port}/favicon.ico?t=${ts}`;
        });
    }

    async testSingle(ip) {
        if (!this._running) return null;
        const latencies = [];

        for (let i = 0; i < this.pingCount; i++) {
            if (!this._running) return null;
            const ms = await this.imagePingOnce(ip);
            latencies.push(ms);
        }

        const valid = latencies.filter(l => l !== Infinity);
        const avg = valid.length > 0
            ? Math.round(valid.reduce((a,b)=>a+b,0)/valid.length)
            : this.timeout;
        const max = valid.length > 0 ? Math.max(...valid) : this.timeout;
        const min = valid.length > 0 ? Math.min(...valid) : this.timeout;
        const lost = latencies.filter(l => l === Infinity).length;
        const lossRate = lost / latencies.length;

        return {
            ip, avg, min, max, lossRate,
            online: valid.length > 0 && avg <= this.timeout * 0.85,
            latencies
        };
    }

    async testBatch(ips, onProgress) {
        this._running = true;
        this._results = [];
        const total = ips.length;
        let completed = 0;
        const results = [];
        const queue = [...ips];

        const work = async () => {
            while (this._running && queue.length > 0) {
                const ip = queue.shift();
                const result = await this.testSingle(ip);
                completed++;
                if (result) { results.push(result); this._results.push(result); }
                if (onProgress) onProgress(completed, total, result);
            }
        };

        const count = Math.min(this.concurrency, ips.length);
        const workers = Array.from({length: count}, () => work());
        await Promise.all(workers);
        this._running = false;

        results.sort((a,b)=>{
            if(a.online && !b.online) return -1;
            if(!a.online && b.online) return 1;
            return a.avg - b.avg;
        });
        return results;
    }

    stop() { this._running = false; }
    getResults() { return this._results; }
}

// ==================== UI 控制 ====================
const App = {
    tester: null,
    allResults: [],

    init() {
        this.bindElements();
        this.bindEvents();
        this.setupTabs();
        // v2.0 默认使用 HTTP/80 (Image Ping 方式)
        this.testPort.value = '80';
    },

    bindElements() {
        this.$ = (id) => document.getElementById(id);
        this.domain = this.$('domain');
        this.testPort = this.$('testPort');
        this.pingCount = this.$('pingCount');
        this.timeout = this.$('timeout');
        this.maxResults = this.$('maxResults');
        this.concurrency = this.$('concurrency');
        this.customIps = this.$('customIps');
        this.cidrInput = this.$('cidrInput');
        this.sampleRate = this.$('sampleRate');
        this.startBtn = this.$('startBtn');
        this.stopBtn = this.$('stopBtn');
        this.exportBtn = this.$('exportBtn');
        this.progressSection = this.$('progressSection');
        this.progressBar = this.$('progressBar');
        this.progressText = this.$('progressText');
        this.progressStats = this.$('progressStats');
        this.logContent = this.$('logContent');
        this.resultsSection = this.$('resultsSection');
        this.resultsSummary = this.$('resultsSummary');
        this.resultsBody = this.$('resultsBody');
    },

    bindEvents() {
        this.startBtn.addEventListener('click', ()=>this.startTest());
        this.stopBtn.addEventListener('click', ()=>this.stopTest());
        this.exportBtn.addEventListener('click', ()=>this.exportResults());
    },

    setupTabs() {
        const tabs = document.querySelectorAll('.tab-btn');
        tabs.forEach(btn => {
            btn.addEventListener('click', ()=>{
                tabs.forEach(t=>t.classList.remove('active'));
                btn.classList.add('active');
                document.querySelectorAll('.tab-content').forEach(tc=>tc.classList.remove('active'));
                this.$('tab-'+btn.dataset.tab).classList.add('active');
            });
        });
    },

    getIpList() {
        const tab = document.querySelector('.tab-btn.active');
        if (!tab) return [];
        switch (tab.dataset.tab) {
            case 'preset': {
                const p = document.querySelector('input[name="preset"]:checked');
                return p ? expandPreset(p.value) : [];
            }
            case 'custom': {
                return this.customIps.value.trim().split('\n')
                    .map(s=>s.trim()).filter(s=>s&&/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s));
            }
            case 'range': {
                try {
                    const all = cidrToIps(this.cidrInput.value.trim());
                    const rate = parseFloat(this.sampleRate.value);
                    return rate>=1 ? all : all.filter(()=>Math.random()<=rate);
                } catch { return []; }
            }
            default: return [];
        }
    },

    async startTest() {
        const ips = this.getIpList();
        if (!ips || ips.length === 0) {
            this.log('❌ 没有有效的 IP 地址', 'error');
            return;
        }

        const approx = Math.round(ips.length/parseInt(this.concurrency.value)*3);
        if (ips.length > 100) {
            this.log(`⚠️ 测试 ${ips.length} 个 IP，预计 ${approx}s+，请耐心等待`, 'warning');
        }

        this.log(`🚀 开始测试 ${ips.length} 个 IP (端口 ${this.testPort.value})...`, 'info');
        this.startBtn.disabled = true;
        this.stopBtn.disabled = false;
        this.exportBtn.disabled = true;
        this.progressSection.style.display = 'block';
        this.resultsSection.style.display = 'none';
        this.resultsBody.innerHTML = '';
        this.allResults = [];

        this.tester = new LatencyTester({
            domain: this.domain.value||'cdn.example.com',
            port: parseInt(this.testPort.value),
            timeout: parseInt(this.timeout.value),
            pingCount: parseInt(this.pingCount.value),
            concurrency: parseInt(this.concurrency.value)
        });

        const maxShow = parseInt(this.maxResults.value);
        let lastLog = 0;

        const results = await this.tester.testBatch(ips, (completed, total, lastResult) => {
            const pct = Math.round(completed/total*100);
            this.progressBar.style.width = pct+'%';
            this.progressText.textContent = `测试中... ${pct}%`;
            this.progressStats.textContent = `${completed} / ${total}`;
            if (lastResult && (Date.now()-lastLog>80 || completed===total)) {
                lastLog = Date.now();
                const s = lastResult.online ? '✅' : '❌';
                const c = lastResult.online ? 'success' : 'error';
                this.log(`${s} ${lastResult.ip} - ${lastResult.online ? lastResult.avg+'ms' : '超时'}`, c);
            }
        });

        this.allResults = results;
        this.displayResults(results, maxShow);
        this.startBtn.disabled = false;
        this.stopBtn.disabled = true;
        this.exportBtn.disabled = results.length === 0;
        this.progressBar.style.width = '100%';
        this.progressText.textContent = '✅ 测试完成';

        const online = results.filter(r=>r.online);
        this.log(`\n✅ 完成！共 ${ips.length} 个，${online.length} 在线`, 'success');
        if (online.length>0) {
            this.log(`🥇 ${online[0].ip} → ${online[0].avg}ms`, 'info');
            if (online[1]) this.log(`🥈 ${online[1].ip} → ${online[1].avg}ms`, 'info');
            if (online[2]) this.log(`🥉 ${online[2].ip} → ${online[2].avg}ms`, 'info');
        } else {
            this.log('💡 全部超时，请尝试增大超时时间或检查网络', 'warning');
        }
    },

    stopTest() {
        if (this.tester) { this.tester.stop(); this.log('⏹ 已停止', 'warning'); }
        this.startBtn.disabled = false;
        this.stopBtn.disabled = true;
    },

    displayResults(results, maxShow) {
        this.resultsSection.style.display = 'block';
        const online = results.filter(r=>r.online);
        const offline = results.filter(r=>!r.online);
        const show = results.slice(0, maxShow);
        this.resultsSummary.textContent =
            `${results.length} 个 · ${online.length} 在线 · ${offline.length} 离线 · 最优 ${online.length>0 ? online[0].avg+'ms' : '无'}`;

        this.resultsBody.innerHTML = show.map((r,i)=>{
            const rc = i===0?'rank-1':i===1?'rank-2':i===2?'rank-3':'rank-other';
            const badge = i<3 ? ['🥇','🥈','🥉'][i] : i+1;
            let lc = 'latency-fast';
            if(r.avg>300) lc='latency-slow';
            else if(r.avg>150) lc='latency-medium';
            const sc = r.online?'status-online':'status-offline';
            const st = r.online?'✅ 在线':'❌ 离线';
            const lp = Math.round(r.lossRate*100);
            return `<tr>
                <td><span class="rank-badge ${rc}">${badge}</span></td>
                <td><strong>${r.ip}</strong></td>
                <td><span class="latency-value ${lc}">${r.online ? r.avg+' ms' : '超时'}</span></td>
                <td>${r.online ? r.max+' ms' : '-'}</td>
                <td>${lp}%</td>
                <td><span class="status-badge ${sc}">${st}</span></td>
                <td><button class="copy-btn" onclick="App.copyIp('${r.ip}')">📋 复制</button></td>
            </tr>`;
        }).join('');
    },

    copyIp(ip) {
        navigator.clipboard.writeText(ip).then(()=>this.log(`📋 已复制: ${ip}`,'success'))
        .catch(()=>{
            const ta = document.createElement('textarea');
            ta.value=ip; document.body.appendChild(ta);
            ta.select(); document.execCommand('copy'); ta.remove();
            this.log(`📋 已复制: ${ip}`,'success');
        });
    },

    exportResults() {
        if (this.allResults.length===0) return;
        let csv = '排名,IP地址,平均延迟(ms),最慢(ms),最快(ms),丢包率(%),状态\n';
        this.allResults.forEach((r,i)=>{
            csv+=`${i+1},${r.ip},${r.avg},${r.max},${r.min},${Math.round(r.lossRate*100)}%,${r.online?'在线':'离线'}\n`;
        });
        const blob = new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'});
        const a = document.createElement('a');
        a.href=URL.createObjectURL(blob);
        a.download=`cf-ip-results-${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        this.log('📥 已导出 CSV','success');
    },

    log(msg, type='info') {
        const div = document.createElement('div');
        div.className=`log-entry ${type}`;
        div.textContent=`> ${msg}`;
        this.logContent.appendChild(div);
        this.logContent.parentElement.scrollTop = this.logContent.parentElement.scrollHeight;
    }
};

document.addEventListener('DOMContentLoaded', ()=>App.init());