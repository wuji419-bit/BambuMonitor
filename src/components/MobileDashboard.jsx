import React from 'react';
import { AlertTriangle, Clock, Printer } from 'lucide-react';

const STATUS_META = {
    printing: { label: '打印中', color: '#6af0a7' },
    idle: { label: '空闲', color: '#94a3b8' },
    paused: { label: '已暂停', color: '#fbbf24' },
    preparing: { label: '准备中', color: '#7dd3fc' },
    finished: { label: '已完成', color: '#a7f3d0' },
    connecting: { label: '连接中', color: '#60a5fa' },
    connected: { label: '已连接', color: '#cbd5e1' },
    error: { label: '需要关注', color: '#ff7b72' },
    no_ip: { label: '等待 IP', color: '#fb923c' },
};

const styles = {
    page: {
        minHeight: '100vh',
        padding: '24px',
        background: 'radial-gradient(circle at top, #1f3b52 0%, #0b1220 45%, #050816 100%)',
        color: '#f8fafc',
    },
    shell: {
        maxWidth: '1200px',
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
    },
    header: {
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '12px',
    },
    title: {
        margin: 0,
        fontSize: '32px',
        fontWeight: 800,
        letterSpacing: '-0.04em',
        background: 'linear-gradient(90deg, #6af0a7 0%, #7dd3fc 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
    },
    badge: {
        padding: '8px 14px',
        borderRadius: '999px',
        border: '1px solid rgba(148, 163, 184, 0.22)',
        background: 'rgba(15, 23, 42, 0.55)',
        color: '#94a3b8',
        fontSize: '12px',
        letterSpacing: '0.08em',
    },
    grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: '16px',
    },
    empty: {
        padding: '48px 24px',
        textAlign: 'center',
        borderRadius: '24px',
        border: '1px solid rgba(148, 163, 184, 0.16)',
        background: 'rgba(15, 23, 42, 0.6)',
        color: '#94a3b8',
    },
    card: {
        position: 'relative',
        overflow: 'hidden',
        minHeight: '260px',
        padding: '24px',
        borderRadius: '24px',
        border: '1px solid rgba(148, 163, 184, 0.16)',
        background: 'linear-gradient(180deg, rgba(15, 23, 42, 0.92) 0%, rgba(9, 14, 25, 0.98) 100%)',
        boxShadow: '0 20px 60px rgba(2, 6, 23, 0.45)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: '20px',
    },
    glow: {
        position: 'absolute',
        inset: '0 auto auto 0',
        width: '100%',
        height: '4px',
        background: 'linear-gradient(90deg, transparent, #6af0a7, transparent)',
        opacity: 0.8,
    },
    topRow: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: '12px',
    },
    printerName: {
        margin: 0,
        fontSize: '24px',
        fontWeight: 700,
        lineHeight: 1.2,
    },
    statusRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginTop: '8px',
        fontSize: '13px',
    },
    printerIcon: {
        color: 'rgba(148, 163, 184, 0.5)',
        flex: '0 0 auto',
    },
    progressWrap: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '6px',
    },
    progressValue: {
        fontSize: '72px',
        fontWeight: 900,
        lineHeight: 1,
        letterSpacing: '-0.06em',
    },
    progressUnit: {
        fontSize: '24px',
        color: '#64748b',
        fontWeight: 700,
    },
    metaRow: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '12px',
        color: '#cbd5e1',
        fontSize: '13px',
    },
    progressTrack: {
        marginTop: '12px',
        width: '100%',
        height: '12px',
        borderRadius: '999px',
        background: 'rgba(30, 41, 59, 0.9)',
        overflow: 'hidden',
    },
};

function getStatusMeta(status) {
    return STATUS_META[status] || { label: status || '未知状态', color: '#cbd5e1' };
}

function getProgressValue(progress) {
    const numeric = Number(progress);
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(100, Math.max(0, numeric));
}

export default function MobileDashboard({ printers }) {
    return (
        <div style={styles.page}>
            <div style={styles.shell}>
                <header style={styles.header}>
                    <h1 style={styles.title}>拓竹打印监控</h1>
                    <div style={styles.badge}>局域网模式</div>
                </header>

                {printers.length === 0 ? (
                    <div style={styles.empty}>正在获取打印机数据...</div>
                ) : (
                    <div style={styles.grid}>
                        {printers.map((printer) => {
                            const progress = getProgressValue(printer.progress);
                            const statusMeta = getStatusMeta(printer.status);

                            return (
                                <section key={printer.dev_id} style={styles.card}>
                                    {printer.status === 'printing' ? <div style={styles.glow} /> : null}

                                    <div style={styles.topRow}>
                                        <div>
                                            <h2 style={styles.printerName}>{printer.name}</h2>
                                            <div style={{ ...styles.statusRow, color: statusMeta.color }}>
                                                {printer.status === 'error' ? <AlertTriangle size={14} /> : <span>●</span>}
                                                <span>{statusMeta.label}</span>
                                            </div>
                                        </div>
                                        <Printer size={24} style={styles.printerIcon} />
                                    </div>

                                    <div style={styles.progressWrap}>
                                        <span style={styles.progressValue}>{progress}</span>
                                        <span style={styles.progressUnit}>%</span>
                                    </div>

                                    <div>
                                        <div style={styles.metaRow}>
                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                                <Clock size={13} />
                                                {printer.timeLeft || '--'}
                                            </span>
                                            <span>层数 {printer.layer || '--'}</span>
                                        </div>
                                        <div style={styles.progressTrack}>
                                            <div
                                                style={{
                                                    width: `${progress}%`,
                                                    height: '100%',
                                                    borderRadius: '999px',
                                                    background: `linear-gradient(90deg, ${statusMeta.color}, #7dd3fc)`,
                                                    transition: 'width 0.4s ease',
                                                }}
                                            />
                                        </div>
                                    </div>
                                </section>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
