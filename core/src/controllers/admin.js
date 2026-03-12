const crypto = require('node:crypto');
/**
 * 管理面板 HTTP 服务
 * 改写为接收 DataProvider 模式
 */

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const express = require('express');
const { Server: SocketIOServer } = require('socket.io');
const { version } = require('../../package.json');
const { CONFIG } = require('../config/config');
const { getLevelExpProgress } = require('../config/gameConfig');
const { getResourcePath } = require('../config/runtime-paths');
const store = require('../models/store');
const { addOrUpdateAccount, deleteAccount } = store;
const { findAccountByRef, normalizeAccountRef, resolveAccountId } = require('../services/account-resolver');
const { createModuleLogger } = require('../services/logger');
const { MiniProgramLoginSession } = require('../services/qrlogin');
const { sendPushooMessage } = require('../services/push');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');
const { loadProto, types } = require('../utils/proto');
const cryptoWasm = require('../utils/crypto-wasm');
const { 
    hashPassword: secureHash, 
    verifyPassword,
    rateLimitMiddleware,
    recordLoginAttempts,
    clearLoginAttempts
} = require('../services/security');

const hashPassword = (pwd) => secureHash(pwd); // 兼容旧接口
const adminLogger = createModuleLogger('admin');

let app = null;
let server = null;
let provider = null; // DataProvider
let io = null;

function emitRealtimeStatus(accountId, status) {
    if (!io) return;
    const id = String(accountId || '').trim();
    if (!id) return;
    io.to(`account:${id}`).emit('status:update', { accountId: id, status });
    io.to('account:all').emit('status:update', { accountId: id, status });
}

function emitRealtimeLog(entry) {
    if (!io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();
    if (id) io.to(`account:${id}`).emit('log:new', payload);
    io.to('account:all').emit('log:new', payload);
}

function emitRealtimeAccountLog(entry) {
    if (!io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();
    if (id) io.to(`account:${id}`).emit('account-log:new', payload);
    io.to('account:all').emit('account-log:new', payload);
}

function startAdminServer(dataProvider) {
    if (app) return;
    provider = dataProvider;

    app = express();
    app.use(express.json());

    const tokens = new Set();

    const issueToken = () => crypto.randomBytes(24).toString('hex');
    const authRequired = (req, res, next) => {
        const token = req.headers['x-admin-token'];
        if (!token || !tokens.has(token)) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }
        req.adminToken = token;
        next();
    };

    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, x-account-id, x-admin-token');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    // 速率限制中间件
    app.use('/api', rateLimitMiddleware({
        windowMs: 60000,  // 1分钟
        maxRequests: 100, // 最多100次
        keyGenerator: (req) => req.ip,
    }));

    const webDist = path.join(__dirname, '../../../web/dist');
    if (fs.existsSync(webDist)) {
        app.use(express.static(webDist));
    } else {
        adminLogger.warn('web build not found', { webDist });
        app.get('/', (req, res) => res.send('web build not found. Please build the web project.'));
    }
    app.use('/game-config', express.static(getResourcePath('gameConfig')));

    // 登录与鉴权
    app.post('/api/login', async (req, res) => {
        const { password } = req.body || {};
        
        // 记录登录尝试
        try {
            recordLoginAttempts(req.ip);
        } catch (error) {
            return res.status(429).json({ ok: false, error: error.message });
        }
        
        const input = String(password || '');
        const storedHash = store.getAdminPasswordHash ? store.getAdminPasswordHash() : '';
        let ok = false;
        
        if (storedHash) {
            // 优先使用安全验证 (支持PBKDF2和SHA256)
            ok = await verifyPassword(input, storedHash);
        } else {
            // 兼容旧配置
            ok = input === String(CONFIG.adminPassword || '');
        }
        
        if (!ok) {
            return res.status(401).json({ ok: false, error: 'Invalid password' });
        }
        
        // 登录成功
        clearLoginAttempts(req.ip);
        const token = issueToken();
        tokens.add(token);
        res.json({ ok: true, data: { token } });
    });

    app.use('/api', (req, res, next) => {
        if (req.path === '/login' || req.path === '/qr/create' || req.path === '/qr/check' || req.path === '/auth/validate') return next();
        return authRequired(req, res, next);
    });

    app.post('/api/admin/change-password', async (req, res) => {
        const body = req.body || {};
        const oldPassword = String(body.oldPassword || '');
        const newPassword = String(body.newPassword || '');
        if (newPassword.length < 4) {
            return res.status(400).json({ ok: false, error: '新密码长度至少为 4 位' });
        }
        const storedHash = store.getAdminPasswordHash ? store.getAdminPasswordHash() : '';
        const ok = storedHash
            ? await verifyPassword(oldPassword, storedHash)
            : oldPassword === String(CONFIG.adminPassword || '');
        if (!ok) {
            return res.status(400).json({ ok: false, error: '原密码错误' });
        }
        const nextHash = await hashPassword(newPassword);
        if (store.setAdminPasswordHash) {
            store.setAdminPasswordHash(nextHash);
        }
        res.json({ ok: true });
    });

    app.get('/api/ping', (req, res) => {
        res.json({ ok: true, data: { ok: true, uptime: process.uptime(), version } });
    });

    app.get('/api/auth/validate', (req, res) => {
        const token = String(req.headers['x-admin-token'] || '').trim();
        const valid = !!token && tokens.has(token);
        if (!valid) {
            return res.status(401).json({ ok: false, data: { valid: false }, error: 'Unauthorized' });
        }
        res.json({ ok: true, data: { valid: true } });
    });

    // API: 调度任务快照（用于调度收敛排查）
    app.get('/api/scheduler', async (req, res) => {
        try {
            const id = getAccId(req);
            if (provider && typeof provider.getSchedulerStatus === 'function') {
                const data = await provider.getSchedulerStatus(id);
                return res.json({ ok: true, data });
            }
            return res.json({ ok: true, data: { runtime: getSchedulerRegistrySnapshot(), worker: null, workerError: 'DataProvider does not support scheduler status' } });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/logout', (req, res) => {
        const token = req.adminToken;
        if (token) {
            tokens.delete(token);
            if (io) {
                for (const socket of io.sockets.sockets.values()) {
                    if (String(socket.data.adminToken || '') === String(token)) {
                        socket.disconnect(true);
                    }
                }
            }
        }
        res.json({ ok: true });
    });

    const getAccountList = () => {
        try {
            if (provider && typeof provider.getAccounts === 'function') {
                const data = provider.getAccounts();
                if (data && Array.isArray(data.accounts)) return data.accounts;
            }
        } catch {
            // ignore provider failures
        }
        const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
        return Array.isArray(data.accounts) ? data.accounts : [];
    };

    const isSoftRuntimeError = (err) => {
        const msg = String((err && err.message) || '');
        return msg === '账号未运行' || msg === 'API Timeout';
    };

    function handleApiError(res, err) {
        if (isSoftRuntimeError(err)) {
            return res.json({ ok: false, error: err.message });
        }
        return res.status(500).json({ ok: false, error: err.message });
    }

    const resolveAccId = (rawRef) => {
        const input = normalizeAccountRef(rawRef);
        if (!input) return '';

        if (provider && typeof provider.resolveAccountId === 'function') {
            const resolvedByProvider = normalizeAccountRef(provider.resolveAccountId(input));
            if (resolvedByProvider) return resolvedByProvider;
        }

        const resolved = resolveAccountId(getAccountList(), input);
        return resolved || input;
    };

    // Helper to get account ID from header
    function getAccId(req) {
        return resolveAccId(req.headers['x-account-id']);
    }

    function buildKnownFriendGidSettings(accountId) {
        return {
            knownFriendGids: store.getKnownFriendGids ? store.getKnownFriendGids(accountId) : [],
            knownFriendGidSyncCooldownSec: store.getKnownFriendGidSyncCooldownSec
                ? store.getKnownFriendGidSyncCooldownSec(accountId)
                : 600,
            autoRemoveNpcFarmers: store.getAutoRemoveNpcFarmers
                ? !!store.getAutoRemoveNpcFarmers(accountId)
                : false,
        };
    }

    function normalizeSyncAllOpenIds(values) {
        const source = Array.isArray(values) ? values : [];
        const normalized = [];
        const seen = new Set();
        for (const item of source) {
            const value = String(item || '').trim().toUpperCase();
            if (!value || value.length > 128) continue;
            if (!/^[0-9A-Z_-]+$/.test(value)) continue;
            if (seen.has(value)) continue;
            seen.add(value);
            normalized.push(value);
        }
        return normalized;
    }

    function buildSyncAllImportSettings(accountId) {
        const state = store.getSyncAllImportState ? store.getSyncAllImportState(accountId) : {};
        return {
            importedAt: Number(state.importedAt || 0),
            openIdCount: Number(state.openIdCount || 0),
            lastSyncAt: Number(state.lastSyncAt || 0),
            lastSyncFriendCount: Number(state.lastSyncFriendCount || 0),
        };
    }

    function createSyncAllImportUserError(message, hint = '') {
        const err = new Error(String(message || '导入失败'));
        err.name = 'SyncAllImportUserError';
        err.syncAllImportUserError = true;
        err.hint = String(hint || '');
        return err;
    }

    function isSyncAllImportUserError(err) {
        return !!(err && typeof err === 'object' && err.syncAllImportUserError);
    }

    function buildSyncAllImportResponseError(err) {
        return {
            ok: false,
            error: String((err && err.message) || '导入失败'),
            hint: String((err && err.hint) || ''),
        };
    }

    function normalizeSyncAllSyncWarning(error) {
        const message = String((error && error.message) || error || '').trim();
        if (!message) {
            return '已保存导入的数据，但这次没有立即完成好友同步。你可以稍后重试，或等待账号在线后自动同步。';
        }
        if (message.includes('连接未打开')) {
            return '已保存导入的数据，但账号当前未在线，暂时无法立即同步好友。账号在线后会自动继续尝试。';
        }
        if (message.includes('请求超时')) {
            return '已保存导入的数据，但这次同步超时了。你可以稍后重试，或等待系统自动同步。';
        }
        return `已保存导入的数据，但本次立即同步没有完成。原因：${message}`;
    }

    async function parseSyncAllRequestHex(hexText) {
        await loadProto();
        const sanitized = String(hexText || '').replace(/[^0-9a-f]/gi, '');
        if (!sanitized) {
            throw createSyncAllImportUserError(
                '没有检测到可导入的数据',
                '请粘贴完整的好友同步数据，支持包含空格和换行',
            );
        }
        if (sanitized.length % 2 !== 0) {
            throw createSyncAllImportUserError(
                '导入数据不完整',
                '请确认复制的是一整段同步数据，没有漏掉开头或结尾',
            );
        }

        const wire = Buffer.from(sanitized, 'hex');
        let gate = null;
        try {
            gate = types.GateMessage.decode(wire);
        } catch {
            throw createSyncAllImportUserError(
                '导入数据格式不正确',
                '请确认粘贴的是 QQ 农场好友同步数据，而不是其他接口或普通日志文本',
            );
        }
        const meta = gate && gate.meta ? gate.meta : null;
        const serviceName = String(meta && meta.service_name || '');
        const methodName = String(meta && meta.method_name || '');
        const messageType = Number(meta && meta.message_type || 0);
        if (serviceName !== 'gamepb.friendpb.FriendService' || methodName !== 'SyncAll' || messageType !== 1) {
            throw createSyncAllImportUserError(
                '这份数据不是好友同步数据',
                '请重新抓取 QQ 农场好友同步请求后再导入',
            );
        }

        let decrypted = null;
        try {
            decrypted = await cryptoWasm.decryptBuffer(gate.body);
        } catch {
            throw createSyncAllImportUserError(
                '导入数据无法识别',
                '请确认数据完整，且来自当前版本的 QQ 农场好友同步请求',
            );
        }
        const requestType = types.SyncAllRequest || types.SyncAllFriendsRequest;
        if (!requestType) {
            throw new Error('SyncAllRequest 类型未加载');
        }

        let request = null;
        try {
            request = requestType.decode(decrypted);
        } catch {
            throw createSyncAllImportUserError(
                '导入数据内容损坏或不完整',
                '请重新复制一次完整的好友同步数据后再试',
            );
        }
        const requestObject = requestType.toObject(request, {
            longs: String,
            bytes: String,
            arrays: true,
            objects: true,
        });
        const openIds = normalizeSyncAllOpenIds(requestObject.open_ids);
        if (openIds.length === 0) {
            throw createSyncAllImportUserError(
                '这份数据里没有解析到可用的好友标识',
                '请确认抓到的是好友同步数据，而不是空请求或其他接口数据',
            );
        }

        return {
            openIds,
            meta: {
                serviceName,
                methodName,
                messageType,
                clientSeq: Number(meta && meta.client_seq || 0),
                serverSeq: Number(meta && meta.server_seq || 0),
            },
            wireBytes: wire.length,
            bodyBytes: decrypted.length,
        };
    }

    function broadcastAccountConfig(accountId) {
        if (provider && typeof provider.broadcastConfig === 'function') {
            provider.broadcastConfig(accountId);
        }
    }

    // API: 完整状态
    app.get('/api/status', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = provider.getStatus(id);
            if (data && data.status) {
                const { level, exp } = data.status;
                const progress = getLevelExpProgress(level, exp);
                data.levelProgress = progress;
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    app.post('/api/automation', async (req, res) => {
        const id = getAccId(req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }
        try {
            let lastData = null;
            for (const [k, v] of Object.entries(req.body)) {
                lastData = await provider.setAutomation(id, k, v);
            }
            res.json({ ok: true, data: lastData || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 农田详情
    app.get('/api/lands', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getLands(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 好友列表
    app.get('/api/friends', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getFriends(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 好友农田详情
    app.get('/api/interact-records', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const data = await provider.getInteractRecords(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    app.get('/api/friend/:gid/lands', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getFriendLands(id, req.params.gid);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 对指定好友执行单次操作（偷菜/浇水/除草/捣乱）
    app.post('/api/friend/:gid/op', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const opType = String((req.body || {}).opType || '');
            const data = await provider.doFriendOp(id, req.params.gid, opType);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 好友黑名单
    app.get('/api/friend-blacklist', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            if (provider && typeof provider.getFriendBlacklist === 'function') {
                const list = await provider.getFriendBlacklist(id);
                return res.json({ ok: true, data: Array.isArray(list) ? list : [] });
            }
            const list = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];
            return res.json({ ok: true, data: Array.isArray(list) ? list : [] });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/friend-blacklist/toggle', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const gid = Number((req.body || {}).gid);
        if (!gid) return res.status(400).json({ ok: false, error: 'Missing gid' });
        const current = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];
        let next;
        if (current.includes(gid)) {
            next = current.filter(g => g !== gid);
        } else {
            next = [...current, gid];
        }
        const saved = store.setFriendBlacklist ? store.setFriendBlacklist(id, next) : next;
        broadcastAccountConfig(id);
        res.json({ ok: true, data: saved });
    });

    app.get('/api/friend-known-gids', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/friend-known-gids', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            if (body.knownFriendGids !== undefined && store.setKnownFriendGids) {
                store.setKnownFriendGids(id, body.knownFriendGids);
            }
            if (body.knownFriendGidSyncCooldownSec !== undefined && store.setKnownFriendGidSyncCooldownSec) {
                store.setKnownFriendGidSyncCooldownSec(id, body.knownFriendGidSyncCooldownSec);
            }
            if (body.autoRemoveNpcFarmers !== undefined && store.setAutoRemoveNpcFarmers) {
                store.setAutoRemoveNpcFarmers(id, body.autoRemoveNpcFarmers);
            }
            broadcastAccountConfig(id);
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/friend-known-gids/add', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const gid = Number((req.body || {}).gid);
        if (!Number.isFinite(gid) || gid <= 0) {
            return res.status(400).json({ ok: false, error: 'GID 无效' });
        }
        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const next = Array.isArray(current) ? [...current, gid] : [gid];
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            if ((req.body || {}).knownFriendGidSyncCooldownSec !== undefined && store.setKnownFriendGidSyncCooldownSec) {
                store.setKnownFriendGidSyncCooldownSec(id, (req.body || {}).knownFriendGidSyncCooldownSec);
            }
            broadcastAccountConfig(id);
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/friend-known-gids/remove', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const gid = Number((req.body || {}).gid);
        if (!Number.isFinite(gid) || gid <= 0) {
            return res.status(400).json({ ok: false, error: 'GID 无效' });
        }
        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const next = Array.isArray(current) ? current.filter(item => Number(item) !== gid) : [];
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            broadcastAccountConfig(id);
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    app.get('/api/friend-syncall-import', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            return res.json({ ok: true, data: buildSyncAllImportSettings(id) });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/friend-syncall-import', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            let previousFriendGidSet = new Set();
            if (provider && typeof provider.getFriends === 'function') {
                try {
                    const previousFriends = await provider.getFriends(id);
                    previousFriendGidSet = new Set(
                        (Array.isArray(previousFriends) ? previousFriends : [])
                            .map(item => Number(item && item.gid))
                            .filter(gid => Number.isFinite(gid) && gid > 0),
                    );
                } catch {}
            }
            const parsed = await parseSyncAllRequestHex(body.hex || '');
            if (!store.setSyncAllOpenIds) {
                throw new Error('当前版本不支持保存 SyncAll 导入数据');
            }

            store.setSyncAllOpenIds(id, parsed.openIds, {
                importedAt: Date.now(),
                resetSyncStatus: true,
            });
            broadcastAccountConfig(id);

            let syncResult = null;
            let resultSummary = null;
            let syncWarning = '';
            if (provider && typeof provider.syncImportedQqFriends === 'function') {
                try {
                    syncResult = await provider.syncImportedQqFriends(id);
                    if (syncResult && syncResult.used && store.setSyncAllLastSyncResult) {
                        store.setSyncAllLastSyncResult(id, syncResult.friendCount, Date.now());
                    }
                    if (provider && typeof provider.getFriends === 'function') {
                        try {
                            const currentFriends = await provider.getFriends(id);
                            const currentList = Array.isArray(currentFriends) ? currentFriends : [];
                            const currentFriendGids = currentList
                                .map(item => Number(item && item.gid))
                                .filter(gid => Number.isFinite(gid) && gid > 0);
                            let existingFriendCount = 0;
                            for (const gid of currentFriendGids) {
                                if (previousFriendGidSet.has(gid)) existingFriendCount += 1;
                            }
                            resultSummary = {
                                fetchedFriendCount: Number(syncResult && syncResult.rawFriendCount) || 0,
                                npcFriendCount: Number(syncResult && syncResult.npcFriendCount) || 0,
                                existingFriendCount,
                                currentFriendCount: currentList.length,
                            };
                        } catch {}
                    }
                } catch (e) {
                    syncResult = {
                        used: false,
                        error: e && e.message ? e.message : String(e || '同步失败'),
                    };
                    syncWarning = normalizeSyncAllSyncWarning(syncResult.error);
                }
            }

            return res.json({
                ok: true,
                data: buildSyncAllImportSettings(id),
                parsed: {
                    openIdCount: parsed.openIds.length,
                    wireBytes: parsed.wireBytes,
                    bodyBytes: parsed.bodyBytes,
                },
                syncResult,
                syncWarning,
                resultSummary,
            });
        } catch (e) {
            if (isSyncAllImportUserError(e)) {
                return res.status(400).json(buildSyncAllImportResponseError(e));
            }
            return handleApiError(res, e);
        }
    });

    // API: 种子列表
    app.get('/api/seeds', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getSeeds(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 背包物品
    app.get('/api/bag', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getBag(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    app.get('/api/bag/seeds', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getBagSeeds(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 每日礼包状态总览
    app.get('/api/daily-gifts', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await provider.getDailyGifts(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 启动账号
    app.post('/api/accounts/:id/start', (req, res) => {
        try {
            const ok = provider.startAccount(resolveAccId(req.params.id));
            if (!ok) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 停止账号
    app.post('/api/accounts/:id/stop', (req, res) => {
        try {
            const ok = provider.stopAccount(resolveAccId(req.params.id));
            if (!ok) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 农场一键操作
    app.post('/api/farm/operate', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const { opType } = req.body; // 'harvest', 'clear', 'plant', 'all'
            await provider.doFarmOp(id, opType);
            res.json({ ok: true });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 数据分析
    app.get('/api/analytics', async (req, res) => {
        try {
            const sortBy = req.query.sort || 'exp';
            const { getPlantRankings } = require('../services/analytics');
            const data = getPlantRankings(sortBy);
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 设置页统一保存（单次写入+单次广播）
    app.post('/api/settings/save', async (req, res) => {
        const id = getAccId(req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }
        try {
            const data = await provider.saveSettings(id, req.body || {});
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/settings/sync', async (req, res) => {
        const sourceAccountId = getAccId(req);
        if (!sourceAccountId) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const rawTargetMode = String(body.targetMode || 'selected').trim().toLowerCase();
            const targetMode = rawTargetMode === 'all' || rawTargetMode === 'selected' ? rawTargetMode : '';
            if (!targetMode) {
                return res.status(400).json({ ok: false, error: '无效的同步目标模式' });
            }
            const payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};
            const allAccountsData = provider.getAccounts ? provider.getAccounts() : { accounts: [] };
            const allAccounts = Array.isArray(allAccountsData.accounts) ? allAccountsData.accounts : [];
            const availableTargets = allAccounts.filter(acc => String(acc.id || '') !== String(sourceAccountId));
            const availableTargetIdSet = new Set(availableTargets.map(acc => String(acc.id || '')));

            let targetAccountIds = [];
            if (targetMode === 'all') {
                targetAccountIds = availableTargets.map(acc => String(acc.id || ''));
            } else {
                const rawTargetIds = Array.isArray(body.targetAccountIds) ? body.targetAccountIds : [];
                targetAccountIds = [...new Set(
                    rawTargetIds
                        .map(accountId => resolveAccId(String(accountId || '')))
                        .filter(accountId => availableTargetIdSet.has(String(accountId || ''))),
                )];
            }

            if (targetAccountIds.length === 0) {
                return res.status(400).json({ ok: false, error: '请至少选择一个目标账号' });
            }

            const result = await provider.syncAccountSettings(targetAccountIds, payload);
            const targetAccounts = availableTargets
                .filter(acc => targetAccountIds.includes(String(acc.id || '')))
                .map(acc => ({
                    id: String(acc.id || ''),
                    name: String(acc.name || acc.nick || acc.id || '').trim(),
                    platform: String(acc.platform || '').trim().toLowerCase(),
                }));

            res.json({
                ok: true,
                data: {
                    ...result,
                    sourceAccountId: String(sourceAccountId || ''),
                    targetMode,
                    targetAccounts,
                },
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 设置面板主题
    app.post('/api/settings/theme', async (req, res) => {
        try {
            const theme = String((req.body || {}).theme || '');
            const data = await provider.setUITheme(theme);
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 保存下线提醒配置
    app.post('/api/settings/offline-reminder', async (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const data = store.setOfflineReminder ? store.setOfflineReminder(body) : {};
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 保存二维码登录接口配置
    app.post('/api/settings/qr-login', async (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const data = store.setQrLoginConfig ? store.setQrLoginConfig(body) : { apiDomain: 'q.qq.com' };
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    // API: 保存运行时连接/设备配置
    app.post('/api/settings/runtime-client', async (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            if (provider && typeof provider.setRuntimeClientConfig === 'function') {
                const data = await provider.setRuntimeClientConfig(body);
                return res.json({ ok: true, data: data || {} });
            }
            const saved = store.setRuntimeClientConfig ? store.setRuntimeClientConfig(body) : null;
            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig('');
            }
            return res.json({ ok: true, data: { runtimeClient: saved } });
        } catch (e) {
            return res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 测试下线提醒推送（不落盘）
    app.post('/api/settings/offline-reminder/test', async (req, res) => {
        try {
            const saved = store.getOfflineReminder ? store.getOfflineReminder() : {};
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const cfg = { ...(saved || {}), ...body };

            const channel = String(cfg.channel || '').trim().toLowerCase();
            const endpoint = String(cfg.endpoint || '').trim();
            const token = String(cfg.token || '').trim();
            const titleBase = String(cfg.title || '账号下线提醒').trim();
            const msgBase = String(cfg.msg || '账号下线').trim();
            const custom_headers = String(cfg.custom_headers || '').trim();
            const custom_body = String(cfg.custom_body || '').trim();

            if (!channel) {
                return res.status(400).json({ ok: false, error: '推送渠道不能为空' });
            }
            if ((channel === 'webhook' || channel === 'custom_request') && !endpoint) {
                return res.status(400).json({ ok: false, error: '接口地址不能为空' });
            }

            const now = new Date();
            const ts = now.toISOString().replace('T', ' ').slice(0, 19);
            const ret = await sendPushooMessage({
                channel,
                endpoint,
                token,
                title: `${titleBase}（测试）`,
                content: `${msgBase}\n\n这是一条下线提醒测试消息。\n时间: ${ts}`,
                custom_headers,
                custom_body,
            });

            if (!ret || !ret.ok) {
                return res.status(400).json({ ok: false, error: (ret && ret.msg) || '推送失败', data: ret || {} });
            }
            return res.json({ ok: true, data: ret });
        } catch (e) {
            return res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 获取配置
    app.get('/api/settings', async (req, res) => {
        try {
            const id = getAccId(req);
            // 直接从主进程的 store 读取，确保即使账号未运行也能获取配置
            const intervals = store.getIntervals(id);
            const strategy = store.getPlantingStrategy(id);
            const preferredSeed = store.getPreferredSeed(id);
            const bagSeedPriority = store.getBagSeedPriority(id);
            const bagSeedFallbackStrategy = store.getBagSeedFallbackStrategy(id);
            const friendQuietHours = store.getFriendQuietHours(id);
            const knownFriendGids = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const knownFriendGidSyncCooldownSec = store.getKnownFriendGidSyncCooldownSec
                ? store.getKnownFriendGidSyncCooldownSec(id)
                : 600;
            const automation = store.getAutomation(id);
            const ui = store.getUI();
            const offlineReminder = store.getOfflineReminder
                ? store.getOfflineReminder()
                : { channel: 'webhook', reloginUrlMode: 'none', endpoint: '', token: '', title: '账号下线提醒', msg: '账号下线', offlineDeleteSec: 1, offlineDeleteEnabled: false, custom_headers: '', custom_body: '' };
            const qrLogin = store.getQrLoginConfig
                ? store.getQrLoginConfig()
                : { apiDomain: 'q.qq.com' };
            res.json({
                ok: true,
                data: {
                    intervals,
                    strategy,
                    preferredSeed,
                    bagSeedPriority,
                    bagSeedFallbackStrategy,
                    friendQuietHours,
                    knownFriendGids,
                    knownFriendGidSyncCooldownSec,
                    automation,
                    ui,
                    offlineReminder,
                    qrLogin,
                    runtimeClient: store.getRuntimeClientConfig
                        ? store.getRuntimeClientConfig()
                        : null,
                },
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 账号管理
    app.get('/api/accounts', (req, res) => {
        try {
            const data = provider.getAccounts();
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 更新账号备注（兼容旧接口）
    app.post('/api/account/remark', (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const rawRef = body.id || body.accountId || body.uin || req.headers['x-account-id'];
            const accountList = getAccountList();
            const target = findAccountByRef(accountList, rawRef);
            if (!target || !target.id) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }

            const remark = String(body.remark !== undefined ? body.remark : body.name || '').trim();
            if (!remark) {
                return res.status(400).json({ ok: false, error: 'Missing remark' });
            }

            const accountId = String(target.id);
            const data = addOrUpdateAccount({ id: accountId, name: remark });
            if (provider && typeof provider.setRuntimeAccountName === 'function') {
                provider.setRuntimeAccountName(accountId, remark);
            }
            if (provider && provider.addAccountLog) {
                provider.addAccountLog('update', `更新账号备注: ${remark}`, accountId, remark);
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/accounts', (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const isUpdate = !!body.id;
            const resolvedUpdateId = isUpdate ? resolveAccId(body.id) : '';
            const payload = isUpdate ? { ...body, id: resolvedUpdateId || String(body.id) } : body;
            let wasRunning = false;
            if (isUpdate && provider.isAccountRunning) {
                wasRunning = provider.isAccountRunning(payload.id);
            }

            // 检查是否仅修改了备注信息
            let onlyRemarkChanged = false;
            if (isUpdate) {
                const oldAccounts = provider.getAccounts();
                const oldAccount = oldAccounts.accounts.find(a => a.id === payload.id);
                if (oldAccount) {
                    // 检查 payload 中是否只包含 id 和 name 字段
                    const payloadKeys = Object.keys(payload);
                    const onlyIdAndName = payloadKeys.length === 2 && payloadKeys.includes('id') && payloadKeys.includes('name');
                    if (onlyIdAndName) {
                        onlyRemarkChanged = true;
                    }
                }
            }

            const data = addOrUpdateAccount(payload);
            if (provider.addAccountLog) {
                const accountId = isUpdate ? String(payload.id) : String((data.accounts[data.accounts.length - 1] || {}).id || '');
                const accountName = payload.name || '';
                provider.addAccountLog(
                    isUpdate ? 'update' : 'add',
                    isUpdate ? `更新账号: ${accountName || accountId}` : `添加账号: ${accountName || accountId}`,
                    accountId,
                    accountName
                );
            }
            // 如果是新增，自动启动
            if (!isUpdate) {
                const newAcc = data.accounts[data.accounts.length - 1];
                if (newAcc) provider.startAccount(newAcc.id);
            } else if (wasRunning && !onlyRemarkChanged) {
                // 如果是更新，且之前在运行，且不是仅修改备注，则重启
                provider.restartAccount(payload.id);
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.delete('/api/accounts/:id', (req, res) => {
        try {
            const resolvedId = resolveAccId(req.params.id) || String(req.params.id || '');
            const before = provider.getAccounts();
            const target = findAccountByRef(before.accounts || [], req.params.id);
            provider.stopAccount(resolvedId);
            const data = deleteAccount(resolvedId);
            if (provider.addAccountLog) {
                provider.addAccountLog('delete', `删除账号: ${(target && target.name) || req.params.id}`, resolvedId, target ? target.name : '');
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 账号日志
    app.get('/api/account-logs', (req, res) => {
        try {
            const limit = Number.parseInt(req.query.limit) || 100;
            const list = provider.getAccountLogs ? provider.getAccountLogs(limit) : [];
            // 与当前 web 前端保持一致：直接返回数组
            res.json(Array.isArray(list) ? list : []);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 日志
    app.get('/api/logs', (req, res) => {
        const queryAccountIdRaw = (req.query.accountId || '').toString().trim();
        const id = queryAccountIdRaw ? (queryAccountIdRaw === 'all' ? '' : resolveAccId(queryAccountIdRaw)) : getAccId(req);
        const options = {
            limit: Number.parseInt(req.query.limit) || 100,
            tag: req.query.tag || '',
            module: req.query.module || '',
            event: req.query.event || '',
            keyword: req.query.keyword || '',
            isWarn: req.query.isWarn,
            timeFrom: req.query.timeFrom || '',
            timeTo: req.query.timeTo || '',
        };
        const list = provider.getLogs(id, options);
        res.json({ ok: true, data: list });
    });

    // API: 清空当前账号运行日志
    app.delete('/api/logs', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = provider.clearLogs(id);

            if (io && provider && typeof provider.getLogs === 'function') {
                const accountLogs = provider.getLogs(id, { limit: 100 });
                io.to(`account:${id}`).emit('logs:snapshot', {
                    accountId: id,
                    logs: Array.isArray(accountLogs) ? accountLogs : [],
                });

                const allLogs = provider.getLogs('', { limit: 100 });
                io.to('account:all').emit('logs:snapshot', {
                    accountId: 'all',
                    logs: Array.isArray(allLogs) ? allLogs : [],
                });
            }

            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // ============ QR Code Login APIs (无需账号选择) ============
    // 这些接口不需要 authRequired 也能调用（用于登录流程）
    app.post('/api/qr/create', async (req, res) => {
        try {
            const qrLogin = store.getQrLoginConfig ? store.getQrLoginConfig() : { apiDomain: 'q.qq.com' };
            const result = await MiniProgramLoginSession.requestLoginCode({ apiDomain: qrLogin.apiDomain });
            res.json({ ok: true, data: result });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/qr/check', async (req, res) => {
        const { code } = req.body || {};
        if (!code) {
            return res.status(400).json({ ok: false, error: 'Missing code' });
        }

        try {
            const qrLogin = store.getQrLoginConfig ? store.getQrLoginConfig() : { apiDomain: 'q.qq.com' };
            const result = await MiniProgramLoginSession.queryStatus(code, { apiDomain: qrLogin.apiDomain });

            if (result.status === 'OK') {
                const ticket = result.ticket;
                const uin = result.uin || '';
                const nickname = result.nickname || ''; // 获取昵称
                const appid = '1112386029'; // Farm appid

                const authCode = await MiniProgramLoginSession.getAuthCode(ticket, appid, { apiDomain: qrLogin.apiDomain });

                let avatar = '';
                if (uin) {
                    avatar = `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640`;
                }

                res.json({ ok: true, data: { status: 'OK', code: authCode, uin, avatar, nickname } });
            } else if (result.status === 'Used') {
                res.json({ ok: true, data: { status: 'Used' } });
            } else if (result.status === 'Wait') {
                res.json({ ok: true, data: { status: 'Wait' } });
            } else {
                res.json({ ok: true, data: { status: 'Error', error: result.msg } });
            }
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('*', (req, res) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/game-config')) {
             return res.status(404).json({ ok: false, error: 'Not Found' });
        }
        if (fs.existsSync(webDist)) {
            res.sendFile(path.join(webDist, 'index.html'));
        } else {
            res.status(404).send('web build not found. Please build the web project.');
        }
    });

    const applySocketSubscription = (socket, accountRef = '') => {
        const incoming = String(accountRef || '').trim();
        const resolved = incoming && incoming !== 'all' ? resolveAccId(incoming) : '';
        for (const room of socket.rooms) {
            if (room.startsWith('account:')) socket.leave(room);
        }
        if (resolved) {
            socket.join(`account:${resolved}`);
            socket.data.accountId = resolved;
        } else {
            socket.join('account:all');
            socket.data.accountId = '';
        }
        socket.emit('subscribed', { accountId: socket.data.accountId || 'all' });

        try {
            const targetId = socket.data.accountId || '';
            if (targetId && provider && typeof provider.getStatus === 'function') {
                const currentStatus = provider.getStatus(targetId);
                socket.emit('status:update', { accountId: targetId, status: currentStatus });
            }
            if (provider && typeof provider.getLogs === 'function') {
                const currentLogs = provider.getLogs(targetId, { limit: 100 });
                socket.emit('logs:snapshot', {
                    accountId: targetId || 'all',
                    logs: Array.isArray(currentLogs) ? currentLogs : [],
                });
            }
            if (provider && typeof provider.getAccountLogs === 'function') {
                const currentAccountLogs = provider.getAccountLogs(100);
                socket.emit('account-logs:snapshot', {
                    logs: Array.isArray(currentAccountLogs) ? currentAccountLogs : [],
                });
            }
        } catch {
            // ignore snapshot push errors
        }
    };

    const port = CONFIG.adminPort || 3000;
    server = app.listen(port, '0.0.0.0', () => {
        adminLogger.info('admin panel started', { url: `http://localhost:${port}`, port });
    });

    io = new SocketIOServer(server, {
        path: '/socket.io',
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
            allowedHeaders: ['x-admin-token', 'x-account-id'],
        },
    });

    io.use((socket, next) => {
        const authToken = socket.handshake.auth && socket.handshake.auth.token
            ? String(socket.handshake.auth.token)
            : '';
        const headerToken = socket.handshake.headers && socket.handshake.headers['x-admin-token']
            ? String(socket.handshake.headers['x-admin-token'])
            : '';
        const token = authToken || headerToken;
        if (!token || !tokens.has(token)) {
            return next(new Error('Unauthorized'));
        }
        socket.data.adminToken = token;
        return next();
    });

    io.on('connection', (socket) => {
        const initialAccountRef = (socket.handshake.auth && socket.handshake.auth.accountId)
            || (socket.handshake.query && socket.handshake.query.accountId)
            || '';
        applySocketSubscription(socket, initialAccountRef);
        socket.emit('ready', { ok: true, ts: Date.now() });

        socket.on('subscribe', (payload) => {
            const body = (payload && typeof payload === 'object') ? payload : {};
            applySocketSubscription(socket, body.accountId || '');
        });
    });
}

module.exports = {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
