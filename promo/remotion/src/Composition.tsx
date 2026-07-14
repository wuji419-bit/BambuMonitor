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

const Dashboard:React.FC<{lang:Lang}> = ({lang}) => <AbsoluteFill className="stage"><RealScreenshot src="ui-dashboard.png" zoom={1.035}/><Caption>{text[lang].lead}</Caption></AbsoluteFill>;

const Modes:React.FC<{lang:Lang}> = ({lang}) => {
  const frame=useCurrentFrame();
  return <AbsoluteFill className="stage modes-real">
    <div className="window w-full" style={{opacity:ease(frame,0,16),transform:`translateY(${interpolate(ease(frame,0,20),[0,1],[28,0])}px)`}}><Img src={staticFile('ui-dashboard.png')}/></div>
    <div className="window w-compact" style={{opacity:ease(frame,18,34),transform:`translateY(${interpolate(ease(frame,18,38),[0,1],[28,0])}px)`}}><Img src={staticFile('ui-compact.png')}/></div>
    <div className="window w-mini" style={{opacity:ease(frame,36,52),transform:`translateY(${interpolate(ease(frame,36,56),[0,1],[28,0])}px)`}}><Img src={staticFile('ui-mini.png')}/></div>
    <Caption>{text[lang].modes}</Caption>
  </AbsoluteFill>;
};

const Cameras:React.FC<{lang:Lang}> = ({lang}) => <AbsoluteFill className="stage camera-real"><div className="camera-wall"><Img src={staticFile('ui-camera-wall.png')}/></div><div className="camera-zoom"><Img src={staticFile('ui-camera-zoom.png')}/></div><Caption>{text[lang].cameras}</Caption></AbsoluteFill>;

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
