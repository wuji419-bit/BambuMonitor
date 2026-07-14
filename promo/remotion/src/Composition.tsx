import React from 'react';
import {AbsoluteFill, Audio, Img, Sequence, interpolate, staticFile, useCurrentFrame} from 'remotion';

type Lang = 'zh' | 'en';

const text = {
  zh: {
    title: '五台打印机，一个工作区',
    lead: '设备状态、打印进度、温度与 AMS 耗材，集中呈现。',
    modes: '完整、紧凑、迷你，三种真实窗口形态。',
    cameras: '同时查看多台摄像头，点击即可放大。',
    settings: '窗口、启动、摄像头与通知，在一处统一管理。',
    end: 'BambuMonitor · Windows + macOS · AGPLv3 开源',
  },
  en: {
    title: 'Five printers. One workspace.',
    lead: 'Device status, print progress, temperatures, and AMS filament in one view.',
    modes: 'Full, compact, and mini: three real window layouts.',
    cameras: 'Watch multiple camera feeds and enlarge any view.',
    settings: 'Manage windows, startup, cameras, and notifications in one place.',
    end: 'BambuMonitor · Windows + macOS · Open source under AGPLv3',
  },
};

const ease = (frame:number, start:number, end:number) => interpolate(frame, [start, end], [0, 1], {extrapolateLeft:'clamp', extrapolateRight:'clamp'});

const Caption:React.FC<{children:React.ReactNode}> = ({children}) => (
  <div className="caption"><span>{children}</span></div>
);

const RealScreenshot:React.FC<{src:string; fit?:'contain'|'cover'; zoom?:number; x?:number; y?:number}> = ({src, fit='contain', zoom=1.02, x=0, y=0}) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 300], [1, zoom], {extrapolateRight:'clamp'});
  return <div className="shot"><Img src={staticFile(src)} style={{objectFit:fit, transform:`translate(${x}px, ${y}px) scale(${scale})`}} /></div>;
};

const Intro:React.FC<{lang:Lang}> = ({lang}) => {
  const frame = useCurrentFrame();
  return <AbsoluteFill className="intro">
    <Img src={staticFile('ui-dashboard.png')} className="intro-bg" />
    <div className="intro-shade" />
    <div className="intro-copy" style={{opacity:ease(frame, 8, 28), transform:`translateY(${interpolate(ease(frame,8,28),[0,1],[24,0])}px)`}}>
      <div className="logo">BM</div><small>BAMBU MONITOR</small><h1>{text[lang].title}</h1>
    </div>
  </AbsoluteFill>;
};

const Dashboard:React.FC<{lang:Lang}> = ({lang}) => <AbsoluteFill className="stage"><RealScreenshot src="ui-dashboard-focus.png" zoom={1.035}/><Caption>{text[lang].lead}</Caption></AbsoluteFill>;

const ModeShot:React.FC<{src:string;label:string;note:string;compact?:boolean;mini?:boolean}> = ({src,label,note,compact,mini}) => {
  const frame=useCurrentFrame();
  const enter=ease(frame,0,18);
  return <AbsoluteFill className="mode-shot" style={{opacity:enter}}><div className={`mode-image ${compact?'is-compact':''} ${mini?'is-mini':''}`} style={{transform:`translateX(${interpolate(enter,[0,1],[70,0])}px) scale(${interpolate(frame,[0,119],[1,1.025])})`}}><Img src={staticFile(src)}/></div><div className="mode-label"><small>WINDOW MODE</small><strong>{label}</strong><span>{note}</span></div></AbsoluteFill>;
};

const Modes:React.FC<{lang:Lang}> = ({lang}) => <AbsoluteFill className="stage modes-real">
  <Sequence durationInFrames={120}><ModeShot src="ui-dashboard-focus.png" label={lang==='zh'?'完整窗口':'FULL'} note="1200 × 430"/></Sequence>
  <Sequence from={120} durationInFrames={120}><ModeShot src="ui-compact-focus.png" label={lang==='zh'?'紧凑窗口':'COMPACT'} note="520 × 315" compact/></Sequence>
  <Sequence from={240} durationInFrames={120}><ModeShot src="ui-mini.png" label={lang==='zh'?'迷你窗口':'MINI'} note="320 × 180" mini/></Sequence>
  <Caption>{text[lang].modes}</Caption>
</AbsoluteFill>;

const CameraShot:React.FC<{src:string;wall?:boolean}> = ({src,wall}) => {
  const frame=useCurrentFrame();
  return <AbsoluteFill className="camera-shot"><Img className="camera-backdrop" src={staticFile(src)}/><div className={wall?'camera-frame is-wall':'camera-frame'} style={{transform:`scale(${interpolate(frame,[0,164],[1,1.025])})`}}><Img src={staticFile(src)}/></div></AbsoluteFill>;
};

const Cameras:React.FC<{lang:Lang}> = ({lang}) => <AbsoluteFill className="stage camera-real">
  <Sequence durationInFrames={165}><CameraShot src="ui-camera-wall-focus.png" wall/></Sequence>
  <Sequence from={165} durationInFrames={165}><CameraShot src="ui-camera-zoom.png"/></Sequence>
  <Caption>{text[lang].cameras}</Caption>
</AbsoluteFill>;

const Settings:React.FC<{lang:Lang}> = ({lang}) => <AbsoluteFill className="stage"><RealScreenshot src="ui-settings.png" zoom={1.025}/><Caption>{text[lang].settings}</Caption></AbsoluteFill>;

const Outro:React.FC<{lang:Lang}> = ({lang}) => {
  const frame=useCurrentFrame();
  return <AbsoluteFill className="outro"><div className="outro-ui"><Img src={staticFile('ui-dashboard.png')}/></div><div className="outro-shade"/><div className="outro-copy" style={{opacity:ease(frame,5,25)}}><div className="logo">BM</div><h1>BambuMonitor</h1><p>{text[lang].end}</p></div></AbsoluteFill>;
};

export const Promo:React.FC<{lang:Lang}> = ({lang}) => <AbsoluteFill className="root">
  <Audio src={staticFile(lang==='zh'?'voice-zh.mp3':'voice-en.mp3')} />
  <Sequence durationInFrames={210}><Intro lang={lang}/></Sequence>
  <Sequence from={210} durationInFrames={450}><Dashboard lang={lang}/></Sequence>
  <Sequence from={660} durationInFrames={360}><Modes lang={lang}/></Sequence>
  <Sequence from={1020} durationInFrames={330}><Cameras lang={lang}/></Sequence>
  <Sequence from={1350} durationInFrames={300}><Settings lang={lang}/></Sequence>
  <Sequence from={1650} durationInFrames={210}><Outro lang={lang}/></Sequence>
</AbsoluteFill>;
