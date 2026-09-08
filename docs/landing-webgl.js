// A procedural 3D market terrain. Decorative geometry, not market prices.
(() => {
  const canvas = document.getElementById('hero-webgl');
  if (!canvas) return;
  const gl = canvas.getContext('webgl', { alpha:true, antialias:true, powerPreference:'low-power' });
  if (!gl) return; // The 2D scene remains available on unsupported devices.
  const vertex = `
    attribute vec3 aPosition;
    uniform float uTime;
    uniform float uAspect;
    uniform vec2 uPointer;
    uniform float uScroll;
    varying float vDepth;
    varying float vHeight;
    varying float vEdge;
    void main() {
      vec3 p = aPosition;
      float t = uTime * .13;
      float ridge = sin(p.x*.14 + p.z*.10 + t)*1.7 + sin(p.x*.29 - p.z*.08 - t*.7)*.85;
      float detail = sin(p.x*.72 + p.z*.34 + t*.8)*.13;
      p.y = ridge + detail - 1.9;
      vHeight = (ridge+2.6)/5.2;
      vEdge = 1. - smoothstep(24.,43.,abs(p.x));
      p.x -= uPointer.x * 1.2;
      p.y -= 5.8 + uPointer.y * .45;
      p.z -= 15. + uScroll*3.;
      float angle = .22 + uScroll*.035;
      float yy = cos(angle)*p.y - sin(angle)*p.z;
      float zz = sin(angle)*p.y + cos(angle)*p.z;
      float near = .5; float far = 150.; float focal = 1.7;
      gl_Position = vec4(p.x*focal/uAspect, yy*focal, -(far+near)/(far-near)*zz-2.*far*near/(far-near), -zz);
      gl_PointSize = clamp(90./max(1.,-zz),1.,3.);
      vDepth = clamp((-zz-8.)/95.,0.,1.);
    }
  `;
  const fragment = `
    precision mediump float;
    uniform float uPoints;
    varying float vDepth;
    varying float vHeight;
    varying float vEdge;
    void main() {
      float alpha = pow(1.-vDepth,2.) * vEdge;
      vec3 color = mix(vec3(.21,.34,.51),vec3(.65,.78,.94),vHeight);
      if (uPoints>.5) {
        float distance = length(gl_PointCoord-vec2(.5));
        if(distance>.5) discard;
        alpha *= (1. - smoothstep(.0,.5,distance))*.95;
        color += .15;
      } else { alpha *= .25; }
      gl_FragColor = vec4(color,alpha);
    }
  `;
  const shaders=[];
  function compile(type,source) {
    const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) {gl.deleteShader(shader);throw new Error('Scene shader unavailable');}
    shaders.push(shader);return shader;
  }
  let program;
  try {
    program=gl.createProgram();
    gl.attachShader(program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error('Scene program unavailable');
  } catch { shaders.forEach(shader=>gl.deleteShader(shader));if(program)gl.deleteProgram(program);return; }
  gl.useProgram(program);shaders.forEach(shader=>gl.deleteShader(shader));
  const grid=[],stars=[];
  const cols=90,rows=70,step=1;
  for(let z=0;z<rows;z++) for(let x=0;x<cols;x++) {
    const px=(x-cols/2)*step,pz=-z*step+5;
    if(x<cols-1)grid.push(px,0,pz,px+step,0,pz);
    if(z<rows-1)grid.push(px,0,pz,px,0,pz-step);
    if((x*13+z*7)%37===0)stars.push(px,0,pz);
  }
  function buffer(data) {const result=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,result);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);return result;}
  const gridBuffer=buffer(grid),starBuffer=buffer(stars);
  const position=gl.getAttribLocation(program,'aPosition');gl.enableVertexAttribArray(position);
  const uniforms=Object.fromEntries(['uTime','uAspect','uPointer','uScroll','uPoints'].map(name=>[name,gl.getUniformLocation(program,name)]));
  gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);gl.clearColor(0,0,0,0);
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  const fine=matchMedia('(pointer: fine)');
  const hero=document.querySelector('.hero'),stage=document.querySelector('.showroom-stage');
  let pointerX=0,pointerY=0,x=0,y=0,frame=0,last=0,visible=true,lost=false,time=0;
  function draw(now) {
    frame=0;
    if(lost||document.hidden||!visible) return;
    const dt=Math.min(60,now-last||16);
    if(now-last>=32||motion.matches) {
      last=now;if(!motion.matches)time+=dt*.001;
      x+=(pointerX-x)*.07;y+=(pointerY-y)*.07;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uniforms.uTime,time);gl.uniform1f(uniforms.uAspect,canvas.clientWidth/Math.max(1,canvas.clientHeight));
      gl.uniform2f(uniforms.uPointer,motion.matches?0:x,motion.matches?0:y);
      gl.uniform1f(uniforms.uScroll,motion.matches?0:Math.min(1,scrollY/900));
      gl.uniform1f(uniforms.uPoints,0);gl.bindBuffer(gl.ARRAY_BUFFER,gridBuffer);gl.vertexAttribPointer(position,3,gl.FLOAT,false,0,0);gl.drawArrays(gl.LINES,0,grid.length/3);
      gl.uniform1f(uniforms.uPoints,1);gl.bindBuffer(gl.ARRAY_BUFFER,starBuffer);gl.vertexAttribPointer(position,3,gl.FLOAT,false,0,0);gl.drawArrays(gl.POINTS,0,stars.length/3);
      stage.style.setProperty('--pointer-rx',`${motion.matches?0:-y*1.5}deg`);
      stage.style.setProperty('--pointer-ry',`${motion.matches?0:x*2}deg`);
    }
    if(!motion.matches)frame=requestAnimationFrame(draw);
  }
  function sync() {cancelAnimationFrame(frame);frame=0;last=0;if(!lost&&!document.hidden&&visible)frame=requestAnimationFrame(draw);}
  function resize() {const ratio=Math.min(devicePixelRatio||1,1.5);canvas.width=Math.round(canvas.clientWidth*ratio);canvas.height=Math.round(canvas.clientHeight*ratio);gl.viewport(0,0,canvas.width,canvas.height);sync();}
  hero.addEventListener('pointermove',event=>{if(!fine.matches||motion.matches)return;const rect=hero.getBoundingClientRect();pointerX=Math.max(-1,Math.min(1,(event.clientX-rect.left)/rect.width*2-1));pointerY=Math.max(-1,Math.min(1,event.clientY/innerHeight*2-1));},{passive:true});
  hero.addEventListener('pointerleave',()=>{pointerX=0;pointerY=0;});
  canvas.addEventListener('webglcontextlost',()=>{lost=true;cancelAnimationFrame(frame);document.documentElement.classList.remove('webgl-ready');});
  document.documentElement.classList.add('webgl-ready');
  if('IntersectionObserver' in window)new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;sync();}).observe(canvas);
  motion.addEventListener('change',sync);document.addEventListener('visibilitychange',sync);addEventListener('resize',resize,{passive:true});resize();
})();
