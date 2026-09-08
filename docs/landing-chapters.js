// A single physical stage: native scroll turns each product view into the next.
(() => {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const sources = [...document.querySelectorAll('[data-story], #execution, #strategy, #agent')];
  if (!sources.length) return;
  const names = ['工作區','市場脈動','產業全景','盤中雷達','走勢牆','價格階梯','組合到價監控','多帳戶','AI 策略','AI Agent'];
  const stream = document.createElement('div'); stream.className = 'feature-stream';
  const stage = document.createElement('div'); stage.className = 'stream-stage';
  const deck = document.createElement('div'); deck.className = 'stream-deck';
  const nav = document.createElement('nav'); nav.className = 'stream-nav'; nav.setAttribute('aria-label','功能展示');
  const counter = document.createElement('div'); counter.className = 'stream-counter'; counter.setAttribute('aria-hidden','true');
  stage.append(counter, deck, nav); stream.append(stage); sources[0].before(stream);
  const rig=document.createElement('div');rig.className='stream-rig';rig.setAttribute('aria-hidden','true');
  rig.innerHTML='<i></i><i></i><i></i><div class=stream-floor></div>';stage.prepend(rig);
  const slides = sources.map((source,index) => {
    const id = source.id;
    const marker = document.createElement('div'); marker.className='stream-marker'; marker.dataset.anchor=id; stream.append(marker);
    const slide = document.createElement('article'); slide.className='stream-slide'; slide.dataset.feature=id;
    const copy = document.createElement('div'); copy.className='stream-copy';
    const label = document.createElement('span'); label.className='stream-label'; label.textContent=`${String(index+1).padStart(2,'0')} / ${names[index]}`;
    copy.append(label,source.querySelector('h2').cloneNode(true));
    const description=source.querySelector('.story-copy>p') || source.querySelector('.section-intro>p, .section-intro>div>p');
    if(description) copy.append(description.cloneNode(true));
    const list=source.querySelector('.story-copy ul'); if(list) copy.append(list.cloneNode(true));
    if(id==='strategy') { const p=document.createElement('p'); p.className='stream-detail'; p.textContent='描述想法 → AI 建立指標與策略 → 在回測面板驗證 → AI 解讀結果'; copy.append(p); }
    if(id==='agent') { const p=document.createElement('p'); p.className='stream-detail'; p.textContent='保存與分支對話 · 技能與背景任務 · 原生指標與策略建立 · 回測結果查詢';copy.append(p); }
    const media = document.createElement('div'); media.className='stream-media';
    source.querySelectorAll('.story-scene>figure, .execution-gallery>figure, .research-gallery>figure, .agent-visual>figure').forEach(figure => media.append(figure.cloneNode(true)));
    media.querySelectorAll('[id]').forEach(node=>node.removeAttribute('id'));
    media.querySelectorAll('img').forEach(img=>{img.loading='eager';});
    slide.append(copy,media);deck.append(slide);
    const button=document.createElement('button');button.type='button';button.textContent=names[index];button.addEventListener('click',()=>marker.scrollIntoView({behavior:'smooth'}));nav.append(button);
    return {source,id,marker,slide,button,copy,media,figures:[...media.children]};
  });
    // Each boundary has its own camera path. Poses are [x%, y%, z, pitch, yaw, roll].
    const paths=[
      {name:'unfold',out:[-12,18,-600,48,-18,-8],into:[18,-20,-850,-35,28,8]},
      {name:'dive',out:[0,0,650,0,-12,0],into:[0,0,-1200,12,0,0]},
      {name:'orbit',out:[-65,-12,-420,-12,78,-9],into:[65,15,-600,18,-78,9]},
      {name:'crane',out:[0,-65,-350,-65,0,0],into:[0,65,-650,65,0,0]},
      {name:'bank',out:[-28,12,-750,20,-25,-32],into:[28,-12,-750,-20,25,32]},
      {name:'hinge',out:[32,0,-480,0,-85,12],into:[-32,0,-480,0,85,-12]},
      {name:'rise',out:[0,48,-800,55,20,0],into:[0,-48,-800,-55,-20,0]},
      {name:'tunnel',out:[0,0,750,-12,0,-12],into:[0,0,-1400,0,20,12]},
      {name:'helix',out:[-45,-32,-650,35,65,-22],into:[45,32,-900,-35,-65,22]},
    ];
  let frame=0, enabled=false, step=0, active=-1;
  function layout() {
    const oldTop=stream.getBoundingClientRect().top;
    const position=enabled && step ? Math.max(0,Math.min(slides.length-1,-oldTop/step)) : null;
    const preserve=enabled && oldTop<=0 && -oldTop<=step*(slides.length-1);
    enabled=!motion.matches && innerHeight>=650;
    document.body.classList.toggle('stream-enabled',enabled);stream.hidden=!enabled;
    step=Math.round(innerHeight*.95);
    stream.style.height=`${step*(slides.length-1)+innerHeight}px`;
    slides.forEach(({source,id,marker},i)=>{source.hidden=enabled;source.id=enabled?`${id}-source`:id;marker.id=enabled?id:'';marker.style.top=`${step*i}px`;});
    if(preserve) {
      const target=enabled ? scrollY+stream.getBoundingClientRect().top+position*step : scrollY+slides[Math.round(position)].source.getBoundingClientRect().top-95;
      window.scrollTo({top:target,behavior:'instant'});
    }
    schedule();
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(render);}
  function render(){
    frame=0;if(!enabled)return;
    const position=Math.max(0,Math.min(slides.length-1,-stream.getBoundingClientRect().top/step));
    const base=Math.floor(position), fraction=position-base;
    // A readable resting interval, then a full depth rotation into the next face.
    const t=Math.max(0,Math.min(1,(fraction-.35)/.65));const eased=t*t*(3-2*t);
    const next=base+(eased>=.5?1:0);
    const path=paths[Math.min(base,paths.length-1)];
    stage.dataset.transition=path.name;
    const transform=(pose,amount)=>`translate3d(${pose[0]*amount}%,${pose[1]*amount}%,${pose[2]*amount}px) rotateX(${pose[3]*amount}deg) rotateY(${pose[4]*amount}deg) rotateZ(${pose[5]*amount}deg)`;
    slides.forEach(({slide,button,copy,media,figures},i)=>{
      const outgoing=i===base, incoming=i===base+1;
      const visible=outgoing || (incoming && eased>0);
      const amount=outgoing?eased:1-eased;
      const pose=outgoing?path.out:path.into;
      slide.style.visibility=visible?'visible':'hidden';
      slide.style.opacity='1';slide.style.transform='none';
      // Text clears before the next caption arrives; media keeps moving through depth.
      copy.style.opacity=String(visible?Math.max(0,1-amount*2.4):0);
      copy.style.transform=`translate3d(0,${(outgoing?-1:1)*amount*45}px,0)`;
      media.style.opacity=String(visible?Math.max(0,1-amount*1.15):0);
      media.style.transform=transform(pose,amount);
      figures.forEach((figure,j)=>{
        const spread=(j-(media.children.length-1)/2)*amount;
        figure.style.setProperty('--panel-pose',`translate3d(${spread*80}px,${spread*35}px,${Math.abs(spread)*150}px) rotateY(${spread*30}deg)`);
      });
      slide.inert=i!==next;slide.setAttribute('aria-hidden',String(i!==next));button.setAttribute('aria-current',i===next?'step':'false');
    });
    const energy=Math.sin(eased*Math.PI);
    rig.style.setProperty('--rig-radius',`${50-energy*(path.name==='dive'||path.name==='tunnel'?48:20)}%`);
    rig.style.opacity=String(.16+energy*.5);
    rig.style.transform=`perspective(1200px) translateZ(${-energy*160}px) rotateX(${path.out[3]*energy*.45}deg) rotateY(${path.out[4]*energy*.45}deg) rotateZ(${path.out[5]*energy}deg)`;
    counter.textContent=`${String(next+1).padStart(2,'0')} — ${String(slides.length).padStart(2,'0')}`;
    stage.style.setProperty('--stream-turn',`${eased*180}deg`);
    if(active!==next){active=next;const button=slides[next].button;nav.scrollTo({left:button.offsetLeft-nav.clientWidth/2+button.offsetWidth/2,behavior:'instant'});}
  }
  addEventListener('scroll',schedule,{passive:true});addEventListener('resize',layout,{passive:true});motion.addEventListener('change',layout);layout();
  if(location.hash){requestAnimationFrame(()=>document.getElementById(location.hash.slice(1))?.scrollIntoView());}
})();
