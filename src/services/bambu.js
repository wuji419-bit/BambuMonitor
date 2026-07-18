// Bambu Lab Local LAN Connection
// MQTT connections now run in main process via IPC for TLS stability in packaged apps
import { electronDevices, electronEvents, electronMqtt, isElectronEnvironment } from './electron.js';
import {
    applyMqttConnectedState,
    applyMqttDisconnectedState,
    applyMqttReconnectingState,
    isReusableMqttConnectionStatus,
} from '../utils/mqttConnectionState.js';
import {
    applyPrinterTelemetry,
    refreshPrinterRemainingTime,
} from '../utils/printerTelemetry.js';

// Scan for printers on local network using SSDP
// This runs in Electron main process via IPC
export async function scanPrinters() {
    if (!isElectronEnvironment()) {
        throw new Error('扫描功能仅在桌面版可用');
    }

    try {
        return await electronDevices.scanPrinters();
    } catch (error) {
        console.error('Scan error:', error);
        return [];
    }
}

export class BambuClient {
    constructor() {
        // Local state for printers (data comes from main process via IPC)
        this.printers = new Map();
        this.callbacks = new Map();
        this.globalUpdateCallback = null;
        this.ipcListenerSetup = false;
        this.countdownTimer = null;
        this.connectionAttempts = new Map();
        this.printerOwners = new Map();
        this.callbackOwners = new Map();
        this.globalUpdateCallbackOwner = null;
    }

    beginConnectionAttempt(serialNumber) {
        const attempt = Symbol(serialNumber);
        this.connectionAttempts.set(serialNumber, attempt);
        this.printerOwners.set(serialNumber, attempt);
        this.callbackOwners.set(serialNumber, attempt);
        return attempt;
    }

    commitConnectionAttempt(serialNumber, attempt, update) {
        if (this.connectionAttempts.get(serialNumber) !== attempt) return false;
        this.connectionAttempts.delete(serialNumber);

        const current = this.printers.get(serialNumber);
        if (!current) return false;

        this.printers.set(serialNumber, update(current));
        this.emitUpdate(serialNumber);
        return true;
    }

    ensureOwner(owners, values, serialNumber) {
        if (!values.has(serialNumber)) return null;
        let owner = owners.get(serialNumber);
        if (!owner) {
            owner = Symbol(serialNumber);
            owners.set(serialNumber, owner);
        }
        return owner;
    }

    captureSerialOwnership(serialNumber) {
        return {
            serialNumber,
            printer: this.ensureOwner(this.printerOwners, this.printers, serialNumber),
            callback: this.ensureOwner(this.callbackOwners, this.callbacks, serialNumber),
            attempt: this.connectionAttempts.get(serialNumber) || null,
        };
    }

    cancelOwnedAttempt(ownership) {
        if (
            ownership.attempt
            && this.connectionAttempts.get(ownership.serialNumber) === ownership.attempt
        ) {
            this.connectionAttempts.delete(ownership.serialNumber);
        }
    }

    cleanOwnedSerialState(ownership) {
        const { serialNumber } = ownership;
        if (ownership.printer && this.printerOwners.get(serialNumber) === ownership.printer) {
            this.printers.delete(serialNumber);
            this.printerOwners.delete(serialNumber);
        }
        if (ownership.callback && this.callbackOwners.get(serialNumber) === ownership.callback) {
            this.callbacks.delete(serialNumber);
            this.callbackOwners.delete(serialNumber);
        }
        this.cancelOwnedAttempt(ownership);
    }

    captureAllOwnership() {
        const serialNumbers = new Set([
            ...this.printers.keys(),
            ...this.callbacks.keys(),
            ...this.connectionAttempts.keys(),
        ]);
        const serials = Array.from(
            serialNumbers,
            (serialNumber) => this.captureSerialOwnership(serialNumber),
        );

        if (this.globalUpdateCallback && !this.globalUpdateCallbackOwner) {
            this.globalUpdateCallbackOwner = Symbol('globalUpdateCallback');
        }

        return {
            serials,
            globalCallback: this.globalUpdateCallbackOwner,
        };
    }

    emitUpdate(serialNumber) {
        const printer = this.printers.get(serialNumber);
        if (!printer) return;

        const snapshot = { ...printer };
        const callback = this.callbacks.get(serialNumber);
        if (callback) {
            callback(snapshot);
        }
        if (this.globalUpdateCallback) {
            this.globalUpdateCallback(snapshot);
        }
    }

    ensureCountdownTimer() {
        if (this.countdownTimer) return;

        this.countdownTimer = setInterval(() => {
            for (const [serialNumber, printer] of this.printers) {
                const updated = refreshPrinterRemainingTime(printer);
                if (updated !== printer) {
                    this.printers.set(serialNumber, updated);
                    this.emitUpdate(serialNumber);
                }
            }

            if (this.printers.size === 0) {
                this.stopCountdownTimer();
            }
        }, 15000);
    }

    stopCountdownTimer() {
        if (!this.countdownTimer) return;
        clearInterval(this.countdownTimer);
        this.countdownTimer = null;
    }

    // Setup IPC listeners for MQTT data from main process
    setupIpcListeners() {
        if (this.ipcListenerSetup || !isElectronEnvironment()) return;

        // Listen for MQTT data from main process
        electronEvents.onMqttData(({ serialNumber, payload }) => {
            this.handleMessage(serialNumber, payload);
        });

        electronEvents.onMqttConnected(({ serialNumber }) => {
            const printer = this.printers.get(serialNumber);
            if (printer) {
                this.printers.set(serialNumber, applyMqttConnectedState(printer));
                this.emitUpdate(serialNumber);
            }
        });

        electronEvents.onMqttReconnecting(({ serialNumber }) => {
            console.log(`[Renderer] MQTT reconnecting: ${serialNumber}`);
            const printer = this.printers.get(serialNumber);
            if (printer) {
                this.printers.set(serialNumber, applyMqttReconnectingState(printer));
                this.emitUpdate(serialNumber);
            }
        });

        // Listen for disconnection events
        electronEvents.onMqttDisconnected(({ serialNumber }) => {
            console.log(`[Renderer] MQTT disconnected: ${serialNumber}`);
            const printer = this.printers.get(serialNumber);
            if (printer) {
                this.printers.set(serialNumber, applyMqttDisconnectedState(printer));
                this.emitUpdate(serialNumber);
            }
        });

        this.ipcListenerSetup = true;
    }

    // Connect to local printer via LAN (now via IPC to main process)
    async connectLocal(ip, accessCode, serialNumber, onUpdate, deviceName = '') {
        if (!isElectronEnvironment()) {
            throw new Error('仅支持桌面版');
        }

        // Setup IPC listeners if not done
        this.setupIpcListeners();
        const connectionAttempt = this.beginConnectionAttempt(serialNumber);

        // Initialize printer object
        const printer = {
            dev_id: serialNumber,
            ip: ip,
            name: deviceName || `Bambu Printer (${ip})`,
            model: 'Unknown',
            status: 'connecting',
            jobStatus: '',
            connectionState: 'connecting',
            statusSource: 'local',
            connectionMode: 'local',
            progress: 0,
            timeLeft: '--',
            layer: '',
            temperature: { nozzle: 0, bed: 0, chamber: 0 },
            fan: 0,
            speed: 100,
            filename: '',
            ams: null
        };

        this.printers.set(serialNumber, printer);
        this.callbacks.set(serialNumber, onUpdate);
        this.ensureCountdownTimer();

        // Notify connecting status
        this.emitUpdate(serialNumber);

        try {
            console.log(`[Renderer] Requesting MQTT connect: ${serialNumber}`);
            const result = await electronMqtt.connect({ mode: 'local', ip, accessCode, serialNumber });

            if (result.success) {
                this.commitConnectionAttempt(
                    serialNumber,
                    connectionAttempt,
                    (current) => applyMqttConnectedState(current),
                );
                return true;
            } else {
                throw new Error(result.error || 'MQTT连接失败');
            }
        } catch (err) {
            console.error(`[Renderer] MQTT connect error:`, err);
            this.commitConnectionAttempt(serialNumber, connectionAttempt, (current) => ({
                ...current,
                status: 'error',
                connectionState: 'error',
                statusSource: 'local',
                connectionMode: 'local',
                errorMsg: err.message,
            }));
            throw err;
        }
    }

    async connectCloud({
        authToken,
        username = '',
        region = 'China',
        serialNumber,
        onUpdate,
        deviceName = '',
        initialPrinter = {},
    }) {
        if (!isElectronEnvironment()) {
            throw new Error('仅支持桌面版');
        }

        this.setupIpcListeners();
        const connectionAttempt = this.beginConnectionAttempt(serialNumber);

        const current = this.printers.get(serialNumber) || {};
        const printer = {
            ...current,
            ...initialPrinter,
            dev_id: serialNumber,
            name: deviceName || initialPrinter.name || current.name || `Bambu Printer (${serialNumber})`,
            model: initialPrinter.model || current.model || 'Unknown',
            status: initialPrinter.status || current.status || 'connecting',
            jobStatus: initialPrinter.jobStatus || current.jobStatus || '',
            connectionState: 'connecting',
            statusSource: 'cloud',
            connectionMode: 'cloud',
            cloudUsername: username || current.cloudUsername || initialPrinter.cloudUsername || '',
            progress: current.progress ?? initialPrinter.progress ?? 0,
            timeLeft: current.timeLeft || initialPrinter.timeLeft || '--',
            layer: current.layer || initialPrinter.layer || '',
            temperature: current.temperature || initialPrinter.temperature || { nozzle: 0, bed: 0, chamber: 0 },
            fan: current.fan ?? initialPrinter.fan ?? 0,
            speed: current.speed ?? initialPrinter.speed ?? 100,
            filename: current.filename || initialPrinter.filename || '',
            ams: current.ams || initialPrinter.ams || null,
            errorMsg: '',
        };

        this.printers.set(serialNumber, printer);
        this.callbacks.set(serialNumber, onUpdate);
        this.ensureCountdownTimer();
        this.emitUpdate(serialNumber);

        try {
            console.log(`[Renderer] Requesting cloud MQTT connect: ${serialNumber}`);
            const result = await electronMqtt.connect({
                mode: 'cloud',
                region,
                authToken,
                username,
                serialNumber,
            });

            if (result.success) {
                this.commitConnectionAttempt(
                    serialNumber,
                    connectionAttempt,
                    (latest) => applyMqttConnectedState(latest),
                );
                return true;
            }

            throw new Error(result.error || '云端 MQTT 连接失败');
        } catch (err) {
            console.error('[Renderer] Cloud MQTT connect error:', err);
            this.commitConnectionAttempt(serialNumber, connectionAttempt, (latest) => ({
                ...latest,
                status: 'error',
                connectionState: 'error',
                statusSource: 'cloud',
                connectionMode: 'cloud',
                errorMsg: err.message,
            }));
            throw err;
        }
    }

    handleMessage(serialNumber, payload) {
        const printer = this.printers.get(serialNumber);
        if (!printer) return;

        const updated = applyPrinterTelemetry(printer, payload);
        if (updated === printer) return;
        this.printers.set(serialNumber, updated);
        this.emitUpdate(serialNumber);
    }

    async disconnect(serialNumber) {
        if (!isElectronEnvironment()) return;

        if (serialNumber) {
            const ownership = this.captureSerialOwnership(serialNumber);
            this.cancelOwnedAttempt(ownership);
            try {
                await electronMqtt.disconnect({ serialNumber });
            } finally {
                this.cleanOwnedSerialState(ownership);
                if (this.printers.size === 0) this.stopCountdownTimer();
            }
        } else {
            const ownership = this.captureAllOwnership();
            for (const serial of ownership.serials) {
                this.cancelOwnedAttempt(serial);
            }
            try {
                await electronMqtt.disconnectAll();
            } finally {
                for (const serial of ownership.serials) {
                    this.cleanOwnedSerialState(serial);
                }
                if (this.globalUpdateCallbackOwner === ownership.globalCallback) {
                    this.globalUpdateCallback = null;
                    this.globalUpdateCallbackOwner = null;
                }
                if (this.printers.size === 0) this.stopCountdownTimer();
            }
        }
    }

    isConnected(serialNumber) {
        const printer = this.printers.get(serialNumber);
        if (!printer) return false;
        if (['offline', 'error'].includes(printer.connectionState)) return false;
        return isReusableMqttConnectionStatus(printer.status);
    }

    getConnectedCount() {
        let count = 0;
        for (const printer of this.printers.values()) {
            if (printer.connectionState === 'online' || (
                !printer.connectionState
                && printer.status !== 'error'
                && printer.status !== 'disconnected'
                && printer.status !== 'connecting'
            )) {
                count++;
            }
        }
        return count;
    }

    // Update callback for a printer (used when switching views)
    setUpdateCallback(serialNumber, callback) {
        if (this.printers.has(serialNumber)) {
            this.callbacks.set(serialNumber, callback);
            this.callbackOwners.set(serialNumber, Symbol(serialNumber));
            // Immediately call with current state
            const printer = this.printers.get(serialNumber);
            if (callback && printer) {
                callback({ ...printer });
            }
        }
    }

    // Get all connected printers (for initializing App state after view switch)
    getAllPrinters() {
        return Array.from(this.printers.values()).map(p => ({ ...p }));
    }

    // Set callbacks for all printers at once (for view switch)
    setGlobalUpdateCallback(callback) {
        this.globalUpdateCallback = callback;
        this.globalUpdateCallbackOwner = Symbol('globalUpdateCallback');

        for (const printer of this.printers.values()) {
            if (callback) {
                callback({ ...printer });
            }
        }
    }
}

export const bambuClient = new BambuClient();
