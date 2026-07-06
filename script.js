/**
 * Cloudflare IP 优选工具 v1.0
 * 纯前端实现，所有测试数据仅在本地处理
 */

// ==================== CDN / IP 库 ====================
// 使用精简种子 IP + 按 /24 网段扩展的方式动态生成
const CF_SEEDS = {
    'china-optimized': [
        '104.16', '104.17', '104.18', '104.19',
        '104.20', '104.21', '104.22', '104.23',
        '104.24', '104.25', '104.26', '104.27',
        '104.28', '104.29', '104.30', '104.31',
        '172.64', '172.65', '172.66', '172.67',
        '172.68', '172.69', '172.70', '172.71',
        '141.101'
    ],
    'global': [
        '104.16', '104.17', '104.18', '104.19',
        '104.20', '104.21', '104.22', '104.23',
        '104.24', '104.25', '104.26', '104.27',
        '104.28', '104.29', '104.30', '104.31',
        '172.64', '172.65', '172.66', '172.67',
        '172.68', '172.69', '172.70', '172.71',
        '141.101', '162.158', '188.114', '198.41'
    ]
};

// ==================== CIDR 工具 ====================
function ipToInt(ip) {
    const parts = ip.split('.');
    return ((+parts[0] << 24) | (+parts[1] << 16) | (+parts[2] << 8) | +parts[3]) >>> 0;
}

function intToIp(int) {
    return `${(int >>> 24)}.${(int >> 16) & 255}.${(int >> 8) & 255}.${int & 255}`;
}

function cidrToIps(cidr) {
    const [base, bits] = cidr.split('/');
    const mask = ~(2 ** (32 - +bits) - 1);
    const start = (ipToInt(base) & mask) >>> 0;
    const end = start + 2 ** (32 - +bits) - 1;
    const ips = [];
    for (let i = start; i <= end; i++) ips.push(intToIp(i));
    return ips;
}

function expandPreset(name, sampleRate = 1.0) {
    const seeds = CF_SEEDS[name] || CF_SEEDS['china-optimized'];
    // 将 A.B 扩展成 A.B.0.0 ~ A.B.255.255 的完整 /16 段
    // 但数量太多，我们限制每个种子取前 N 个 /24 段
    const ips = [];
    for (const seed of seeds) {
        const [a, b] = seed.split('.').map(Number);
        // 每个种子取 32 个 /24 段 (0-31)，每个段取一个随机末位
        for (let c = 0; c < 32; c++) {
            if (Math.random() > sampleRate) continue;
            const d = Math.floor(Math.random() * 254) + 1;
            ips.push(`${a}.${b}.${c}.${d}`);
        }
    }
    return ips;
}

// ==================== 延迟测试引擎 ====================
class LatencyTester {
    constructor(options = {}) {
        this.domain = options.domain || 'cdn.example.com';
        this.port = options.port || 443;
        this.timeout = options.timeout || 2000;
        this.pingCount = options.pingCount || 3;
        this.concurrency = options.concurrency || 20;
        this._running = false;
        this._results = [];
    }

    async testSingle(ip) {
        if (!this._running) return null;
        const latencies = [];
        const startTime = performance.now();

        for (let i = 0; i < this.pingCount; i++) {
            if (!this._running) return null;
            try {
                const t0 = performance.now();
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), this.timeout);

                const url = `https://${ip}:${this.port}/cdn-cgi/trace`;
                const resp = await fetch(url, {
                    method: 'GET',
                    mode: 'no-cors',
                    signal: controller.signal,
                    cache: 'no-store'
                });
                clearTimeout(timer);
                const elapsed = performance.now() - t0;
                latencies.push(Math.round(elapsed));
            } catch {
                // 超时或失败，记录为超时值
                latencies.push(this.timeout);
            }
        }

        const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const max = Math.max(...latencies);
        const min = Math.min(...latencies);
        const lost = latencies.filter(l => l >= this.timeout).length;
        const lossRate = lost / latencies.length;

        return {
            ip,
            avg: Math.round(avg),
            min,
            max,
            lossRate,
            online: avg < this.timeout * 0.8,
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
        const workers = [];

        const work = async () => {
            while (this._running && queue.length > 0) {
                const ip = queue.shift();
                const result = await this.testSingle(ip);
                completed++;
                if (result) {
                    results.push(result);
                    this._results.push(result);
                }
                if (onProgress) {
                    onProgress(completed, total, result);
                }
            }
        };

        const workerCount = Math.min(this.concurrency, ips.length);
        for (let i = 0; i < workerCount; i++) {
            workers.push(work());
        }

        await Promise.all(workers);
        this._running = false;

        // 排序：按平均延迟升序（在线优先）
        results.sort((a, b) => {
            if (a.online && !b.online) return -1;
            if (!a.online && b.online) return 1;
            return a.avg - b.avg;
        });

        return results;
    }

    stop() {
        this._running = false;
    }

    getResults() {
        return this._results;
    }
}

// ==================== UI 控制 ====================
const App = {
    tester: null,
    allResults: [],

    init() {
        this.bindElements();
        this.bindEvents();
        this.setupTabs();
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
        this.startBtn.addEventListener('click', () => this.startTest());
        this.stopBtn.addEventListener('click', () => this.stopTest());
        this.exportBtn.addEventListener('click', () => this.exportResults());
    },

    setupTabs() {
        const tabs = document.querySelectorAll('.tab-btn');
        tabs.forEach(btn => {
            btn.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                btn.classList.add('active');
                document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
                this.$('tab-' + btn.dataset.tab).classList.add('active');
            });
        });
    },

    getIpList() {
        const activeTab = document.querySelector('.tab-btn.active');
        if (!activeTab) return [];

        switch (activeTab.dataset.tab) {
            case 'preset': {
                const preset = document.querySelector('input[name="preset"]:checked');
                if (!preset) return [];
                const rate = parseFloat(this.sampleRate.value);
                return expandPreset(preset.value, rate);
            }
            case 'custom': {
                const text = this.customIps.value.trim();
                if (!text) return [];
                return text.split('\n')
                    .map(s => s.trim())
                    .filter(s => s && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s));
            }
            case 'range': {
                const cidr = this.cidrInput.value.trim();
                if (!cidr) return [];
                try {
                    const all = cidrToIps(cidr);
                    const rate = parseFloat(this.sampleRate.value);
                    if (rate >= 1) return all;
                    return all.filter(() => Math.random() <= rate);
                } catch {
                    this.log('❌ CIDR 格式错误，请检查输入', 'error');
                    return [];
                }
            }
            default:
                return [];
        }
    },

    async startTest() {
        const ips = this.getIpList();
        if (!ips || ips.length === 0) {
            this.log('❌ 没有有效的 IP 地址，请检查配置', 'error');
            return;
        }

        this.log(`🚀 开始测试 ${ips.length} 个 IP...`, 'info');
        
        // UI 状态切换
        this.startBtn.disabled = true;
        this.stopBtn.disabled = false;
        this.exportBtn.disabled = true;
        this.progressSection.style.display = 'block';
        this.resultsSection.style.display = 'none';
        this.resultsBody.innerHTML = '';
        this.allResults = [];

        const port = parseInt(this.testPort.value);
        const domain = this.domain.value || 'cdn.example.com';

        this.tester = new LatencyTester({
            domain,
            port,
            timeout: parseInt(this.timeout.value),
            pingCount: parseInt(this.pingCount.value),
            concurrency: parseInt(this.concurrency.value)
        });

        const maxShow = parseInt(this.maxResults.value);

        const results = await this.tester.testBatch(ips, (completed, total, lastResult) => {
            const pct = Math.round((completed / total) * 100);
            this.progressBar.style.width = pct + '%';
            this.progressText.textContent = `测试中... ${pct}%`;
            this.progressStats.textContent = `${completed} / ${total}`;

            if (lastResult) {
                const status = lastResult.online ? '✅' : '❌';
                const color = lastResult.online ? 'success' : 'error';
                this.log(`${status} ${lastResult.ip} - ${lastResult.avg}ms (丢包 ${Math.round(lastResult.lossRate * 100)}%)`, color);
            }
        });

        this.allResults = results;
        this.displayResults(results, maxShow);
        
        // 恢复 UI
        this.startBtn.disabled = false;
        this.stopBtn.disabled = true;
        this.exportBtn.disabled = results.length === 0;

        this.progressBar.style.width = '100%';
        this.progressText.textContent = '✅ 测试完成';
        
        this.log(`\n✅ 测试完成！共测试 ${ips.length} 个 IP，${results.filter(r => r.online).length} 个在线`, 'success');
        this.log(`🏆 最快: ${results.length > 0 ? results[0].ip + ' - ' + results[0].avg + 'ms' : '无'}\n`, 'info');
    },

    stopTest() {
        if (this.tester) {
            this.tester.stop();
            this.log('⏹ 已手动停止测试', 'warning');
        }
        this.startBtn.disabled = false;
        this.stopBtn.disabled = true;
    },

    displayResults(results, maxShow) {
        this.resultsSection.style.display = 'block';
        const online = results.filter(r => r.online);
        const offline = results.filter(r => !r.online);
        const show = results.slice(0, maxShow);

        this.resultsSummary.textContent = `${results.length} 个结果 · ${online.length} 个在线 · ${offline.length} 个离线 · 最优延迟 ${online.length > 0 ? online[0].avg + 'ms' : '无'}`;

        this.resultsBody.innerHTML = show.map((r, i) => {
            const rankClass = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : 'rank-other';
            const badge = i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1;
            
            let latencyClass = 'latency-fast';
            if (r.avg > 300) latencyClass = 'latency-slow';
            else if (r.avg > 150) latencyClass = 'latency-medium';

            const statusClass = r.online ? 'status-online' : 'status-offline';
            const statusText = r.online ? '✅ 在线' : '❌ 离线';
            const lossPct = Math.round(r.lossRate * 100);

            return `<tr>
                <td><span class="rank-badge ${rankClass}">${badge}</span></td>
                <td><strong>${r.ip}</strong></td>
                <td><span class="latency-value ${latencyClass}">${r.avg} ms</span></td>
                <td>${r.max} ms</td>
                <td>${lossPct}%</td>
                <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                <td><button class="copy-btn" onclick="App.copyIp('${r.ip}')">📋 复制</button></td>
            </tr>`;
        }).join('');
    },

    copyIp(ip) {
        navigator.clipboard.writeText(ip).then(() => {
            this.log(`📋 已复制: ${ip}`, 'success');
        }).catch(() => {
            // Fallback
            const ta = document.createElement('textarea');
            ta.value = ip;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            this.log(`📋 已复制: ${ip}`, 'success');
        });
    },

    exportResults() {
        if (this.allResults.length === 0) return;
        
        let csv = '排名,IP地址,平均延迟(ms),最慢(ms),最快(ms),丢包率(%),状态\n';
        this.allResults.forEach((r, i) => {
            csv += `${i + 1},${r.ip},${r.avg},${r.max},${r.min},${Math.round(r.lossRate * 100)}%,${r.online ? '在线' : '离线'}\n`;
        });

        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cf-ip-results-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        
        this.log('📥 结果已导出为 CSV 文件', 'success');
    },

    log(msg, type = 'info') {
        const div = document.createElement('div');
        div.className = `log-entry ${type}`;
        div.textContent = `> ${msg}`;
        this.logContent.appendChild(div);
        this.logContent.parentElement.scrollTop = this.logContent.parentElement.scrollHeight;
    }
};

// ==================== 启动 ====================
document.addEventListener('DOMContentLoaded', () => App.init());