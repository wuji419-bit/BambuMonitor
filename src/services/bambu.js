// Bambu Lab Local LAN Connection
// MQTT connections now run in main process via IPC for TLS stability in packaged apps
import { electronDevices, electronEvents, electronMqtt, isElectronEnvironment } from './electron';

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
        this.ipcListenerSetup = false;
    }

    emitUpdate(serialNumber) {
        const printer = this.printers.get(serialNumber);
        if (!printer) return;

        const callback = this.callbacks.get(serialNumber);
        if (callback) {
            callback({ ...printer });
        }
    }

    // Setup IPC listeners for MQTT data from main process
    setupIpcListeners() {
        if (this.ipcListenerSetup || !isElectronEnvironment()) return;

        // Listen for MQTT data from main process
        electronEvents.onMqttData(({ serialNumber, payload }) => {
            this.handleMessage(serialNumber, payload);
        });

        // Listen for disconnection events
        electronEvents.onMqttDisconnected(({ serialNumber }) => {
            console.log(`[Renderer] MQTT disconnected: ${serialNumber}`);
            const printer = this.printers.get(serialNumber);
            if (printer) {
                printer.status = 'disconnected';
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

        // Initialize printer object
        const printer = {
            dev_id: serialNumber,
            ip: ip,
            name: deviceName || `Bambu Printer (${ip})`,
            model: 'Unknown',
            status: 'connecting',
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

        // Notify connecting status
        this.emitUpdate(serialNumber);

        try {
            console.log(`[Renderer] Requesting MQTT connect: ${serialNumber}`);
            const result = await electronMqtt.connect({ ip, accessCode, serialNumber });

            if (result.success) {
                // Wait for first telemetry before claiming idle/printing.
                printer.status = 'connected';
                delete printer.errorMsg;
                this.emitUpdate(serialNumber);
                return true;
            } else {
                throw new Error(result.error || 'MQTT连接失败');
            }
        } catch (err) {
            console.error(`[Renderer] MQTT connect error:`, err);
            printer.status = 'error';
            printer.errorMsg = err.message;
            this.emitUpdate(serialNumber);
            throw err;
        }
    }

    handleMessage(serialNumber, payload) {
        const printer = this.printers.get(serialNumber);
        if (!printer) return;

        const data = payload.print || payload;
        if (!data) return;

        // Update printer state
        if (data.mc_percent !== undefined) {
            const progress = Number(data.mc_percent);
            if (Number.isFinite(progress)) {
                printer.progress = Math.min(100, Math.max(0, progress));
            }
        }
        if (data.mc_remaining_time !== undefined) {
            printer.timeLeft = this.formatTime(Number(data.mc_remaining_time));
        }
        if (data.gcode_state) {
            const stateMap = {
                'RUNNING': 'printing',
                'PAUSE': 'paused',
                'IDLE': 'idle',
                'FINISH': 'finished',
                'FAILED': 'error',
                'PREPARE': 'preparing'
            };
            printer.status = stateMap[data.gcode_state] || data.gcode_state.toLowerCase();
        }
        if (data.layer_num !== undefined) {
            const currentLayer = Number(data.layer_num);
            const totalLayer = Number(data.total_layer_num);
            printer.layer = `${Number.isFinite(currentLayer) ? currentLayer : '?'}`
                + `/${Number.isFinite(totalLayer) && totalLayer >= 0 ? totalLayer : '?'}`;
        }
        if (data.nozzle_temper !== undefined) {
            printer.temperature.nozzle = Math.round(data.nozzle_temper);
        }
        if (data.bed_temper !== undefined) {
            printer.temperature.bed = Math.round(data.bed_temper);
        }
        if (data.chamber_temper !== undefined) {
            printer.temperature.chamber = Math.round(data.chamber_temper);
        }
        if (data.cooling_fan_speed !== undefined) {
            printer.fan = Math.round(data.cooling_fan_speed / 255 * 100);
        }
        if (data.spd_lvl !== undefined) {
            const speedMap = { 1: 50, 2: 100, 3: 125, 4: 166 };
            printer.speed = speedMap[data.spd_lvl] || 100;
        }
        if (data.gcode_file) {
            const parts = data.gcode_file.split('/');
            printer.filename = parts[parts.length - 1] || data.gcode_file;
        }
        if (data.subtask_name) {
            printer.filename = data.subtask_name;
        }

        // AMS is not included in every telemetry packet. Keep the last known AMS
        // state instead of clearing it when regular print-status packets arrive.
        if (data.ams && Array.isArray(data.ams.ams)) {
            let activeAmsIndex = null;
            let activeTrayIndex = null;

            const extruderInfo = data.device?.extruder?.info;
            if (Array.isArray(extruderInfo)) {
                const nozzle0 = extruderInfo.find((entry) => Number(entry?.id) === 0 && entry?.snow !== undefined);
                if (nozzle0 && Number.isFinite(Number(nozzle0.snow))) {
                    const snow = Number(nozzle0.snow);
                    activeAmsIndex = snow >> 8;
                    activeTrayIndex = snow & 0x3;
                }
            }

            if (activeAmsIndex === null && data.ams.tray_now !== undefined) {
                const trayNow = Number(data.ams.tray_now);
                if (Number.isFinite(trayNow)) {
                    if (trayNow === 255) {
                        activeAmsIndex = null;
                        activeTrayIndex = null;
                    } else if (trayNow === 254) {
                        activeAmsIndex = 255; // external spool
                        activeTrayIndex = 0;
                    } else if (trayNow >= 80) {
                        activeAmsIndex = trayNow;
                        activeTrayIndex = 0;
                    } else {
                        activeAmsIndex = trayNow >> 2;
                        activeTrayIndex = trayNow & 0x3;
                    }
                }
            }

            const amsUnits = data.ams.ams.map((unit) => {
                const unitIndex = Number(unit?.id);
                const humidityIndex = Number(unit?.humidity);
                const humidityRaw = Number(unit?.humidity_raw);
                const temperature = Number(unit?.temp);

                const trays = Array.isArray(unit?.tray)
                    ? unit.tray.map((tray) => ({
                        id: Number(tray?.id),
                        remain: Number(tray?.remain),
                        trayWeight: Number(tray?.tray_weight),
                        type: tray?.tray_type || '',
                        color: tray?.tray_color || '',
                        idx: tray?.tray_info_idx || '',
                        subBrand: tray?.tray_sub_brands || '',
                        name: tray?.tray_type || '',
                        trayUuid: tray?.tray_uuid || ''
                    }))
                    : [];

                const activeTray = trays.find((tray) => tray.id === activeTrayIndex) || null;

                return {
                    index: unitIndex,
                    humidityIndex: Number.isFinite(humidityIndex) ? humidityIndex : null,
                    humidityRaw: Number.isFinite(humidityRaw) ? humidityRaw : null,
                    temperature: Number.isFinite(temperature) ? temperature : null,
                    trays,
                    activeTray
                };
            });

            printer.ams = {
                activeAmsIndex,
                activeTrayIndex,
                units: amsUnits
            };
        } else if (data.ams === null) {
            printer.ams = null;
        }

        // Trigger callback
        this.emitUpdate(serialNumber);
    }

    formatTime(minutes) {
        if (!minutes || minutes <= 0) return '--';
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    async disconnect(serialNumber) {
        if (!isElectronEnvironment()) return;

        if (serialNumber) {
            await electronMqtt.disconnect({ serialNumber });
            this.printers.delete(serialNumber);
            this.callbacks.delete(serialNumber);
        } else {
            // Disconnect all
            await electronMqtt.disconnectAll();
            this.printers.clear();
            this.callbacks.clear();
        }
    }

    isConnected(serialNumber) {
        const printer = this.printers.get(serialNumber);
        return printer ? (printer.status !== 'error' && printer.status !== 'disconnected' && printer.status !== 'connecting') : false;
    }

    getConnectedCount() {
        let count = 0;
        for (const printer of this.printers.values()) {
            if (printer.status !== 'error' && printer.status !== 'disconnected' && printer.status !== 'connecting') {
                count++;
            }
        }
        return count;
    }

    // Update callback for a printer (used when switching views)
    setUpdateCallback(serialNumber, callback) {
        if (this.printers.has(serialNumber)) {
            this.callbacks.set(serialNumber, callback);
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
        for (const serialNumber of this.printers.keys()) {
            this.callbacks.set(serialNumber, (printer) => callback(printer));
        }
        // Call callback with all current printers
        for (const printer of this.printers.values()) {
            if (callback) {
                callback({ ...printer });
            }
        }
    }
}

export const bambuClient = new BambuClient();
