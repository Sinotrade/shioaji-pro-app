// Decorative market chronometer: time dial, price ribbons, and a strategy graph.
// All geometry is procedural illustration, never live market data.
(() => {
  const stage=document.querySelector('.stream-stage');if(!stage)return;
  const canvas=document.createElement('canvas');canvas.className='market-model';canvas.setAttribute('aria-hidden','true');stage.prepend(canvas);
  const gl=canvas.getContext('webgl',{alpha:true,antialias:true,powerPreference:'low-power'});if(!gl){canvas.remove();return;}
  const vertex=`
    attribute vec3 position; attribute vec3 color; attribute float group; attribute float phase;
    uniform float time; uniform float progress; uniform float energy; uniform float aspect;
    varying mediump vec4 tint;
    vec3 turnY(vec3 p,float a){return vec3(p.x*cos(a)+p.z*sin(a),p.y,-p.x*sin(a)+p.z*cos(a));}
    vec3 turnX(vec3 p,float a){return vec3(p.x,p.y*cos(a)-p.z*sin(a),p.y*sin(a)+p.z*cos(a));}
    void main(){
      vec3 p=position;
      float speed=group<.5?.035:(group<1.5?-.065:.12);
      p=turnY(p,time*speed);
      if(group>1.5)p=turnX(p,sin(time*.12)*.15);
      p=turnX(p,.58+progress*.32);p=turnY(p,-.2+sin(progress*.55)*.35);
      float depth=p.z;
      p.z-=7.8-energy*.6;
      float focal=2.1;
      gl_Position=vec4(p.x*focal/aspect,p.y*focal,-1.004*p.z-.2,-p.z);
      gl_Position.x+=(.20-energy*.20)*gl_Position.w;
      float sweep=pow(max(0.,cos(phase-time*(group<1.5?.7:1.4))),22.);
      float alpha=(.20+.17*(depth+3.)/6.+sweep*.48)*(.65+energy*.8);
      tint=vec4(color+vec3(sweep*.22),alpha*(group>1.5?1.3:1.));
      gl_PointSize=(7.+sweep*8.)*focal*2./max(1.,-p.z);
    }`;
  const fragment=`precision mediump float;uniform float points;varying mediump vec4 tint;
    void main(){float a=tint.a;if(points>.5){float d=length(gl_PointCoord-.5);if(d>.5)discard;a*=1.-smoothstep(.1,.5,d);}gl_FragColor=vec4(tint.rgb,a);}`;
  let program;const shaders=[];
  try{
    program=gl.createProgram();
    for(const [type,source]of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){const shader=gl.createShader(type);shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));gl.attachShader(program,shader);}
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
  }catch(error){console.warn('Market model unavailable:',error.message);shaders.forEach(s=>gl.deleteShader(s));if(program)gl.deleteProgram(program);canvas.remove();return;}
  shaders.forEach(s=>gl.deleteShader(s));gl.useProgram(program);
  const lines=[],dots=[];const tau=Math.PI*2;
  const silver=[.64,.76,.88],blue=[.31,.53,.72],pearl=[.78,.85,.91],amber=[.68,.57,.40];
  const v=(target,p,c,g,phase=0)=>target.push(...p,...c,g,phase);
  const edge=(a,b,c,g,phase=0)=>{v(lines,a,c,g,phase);v(lines,b,c,g,phase+.02);};
  const polar=(r,a,y=0)=>[r*Math.cos(a),y,r*Math.sin(a)];
  function ring(r,y,c,g=0){for(let i=0;i<240;i++)edge(polar(r,i*tau/240,y),polar(r,(i+1)*tau/240,y),c,g,i*tau/240);}
  // Machined concentric time scales and fine radial graduations.
  [2.6,2.68,2.95,3.02].forEach(r=>ring(r,0,silver));
  ring(2.68,-.12,blue);ring(2.95,-.12,blue);
  for(let i=0;i<180;i++){const a=i*tau/180;edge(polar(i%15===0?2.7:2.83,a),polar(2.94,a),i%15===0?pearl:blue,0,a);if(i%15===0)edge(polar(2.95,a,0),polar(2.95,a,-.12),silver,0,a);}
  // Price and volume become an elevated circular market landscape.
  const price=a=>.28+Math.sin(a*3)*.17+Math.cos(a*7)*.10+Math.sin(a*13)*.04;
  for(let lane=0;lane<3;lane++)for(let i=0;i<240;i++){
    const a=i*tau/240,b=(i+1)*tau/240,r=1.8+lane*.17;
    edge(polar(r,a,price(a)+lane*.12),polar(r,b,price(b)+lane*.12),lane===1?pearl:blue,1,a);
    if(i%4===0)edge(polar(r,a,-.30),polar(r,a,price(a)+lane*.12),blue,1,a);
  }
  for(let i=0;i<64;i++){
    const a=i*tau/64,y=price(a),r=2.3,h=.07+.12*Math.abs(Math.sin(a*5));
    edge(polar(r,a,y-h),polar(r,a,y+h),i%3?silver:amber,1,a);
    const corners=[polar(r,a-.009,y-.045),polar(r,a+.009,y-.045),polar(r,a+.009,y+.045),polar(r,a-.009,y+.045)];
    for(let j=0;j<4;j++)edge(corners[j],corners[(j+1)%4],i%3?silver:amber,1,a);
  }
  // Fibonacci sphere: sparse model nodes and short graph edges, not a wire cube.
  const nodes=[];
  for(let i=0;i<70;i++){
    const y=1-2*(i+.5)/70,r=Math.sqrt(1-y*y),a=i*2.399963;
    const p=[r*Math.cos(a)*.95,y*.95,r*Math.sin(a)*.95];nodes.push(p);v(dots,p,pearl,2,a);
  }
  nodes.forEach((p,i)=>nodes.slice(i+1).forEach((q,j)=>{const d=Math.hypot(...p.map((n,k)=>n-q[k]));if(d<.48)edge(p,q,silver,2,(i+j)*.3);}));
  // Curved inference paths link the model to the market shell.
  for(let arm=0;arm<8;arm++){
    const a=arm*tau/8;
    for(let j=0;j<45;j++){
      const point=t=>polar(.9+t*1.6,a+t*.7,Math.sin(t*Math.PI)*(.45+arm%2*.25));
      edge(point(j/45),point((j+1)/45),arm%2?blue:amber,2,j*.08+arm);
    }
  }
  // Tilted time meridians enclosing the neural core.
  for(let band=0;band<2;band++)for(let i=0;i<200;i++){
    const point=a=>{const x=Math.cos(a)*1.3,y=Math.sin(a)*1.3;return [x,y*Math.cos(.4+band*.9),y*Math.sin(.4+band*.9)];};
    edge(point(i*tau/200),point((i+1)*tau/200),silver,2,i*tau/200);
  }
  const buffers=[lines,dots].map(data=>{const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);return b;});
  const attributes=[['position',3,0],['color',3,3],['group',1,6],['phase',1,7]].map(([name,size,offset])=>({location:gl.getAttribLocation(program,name),size,offset}));
  const uniforms=Object.fromEntries(['time','progress','energy','aspect','points'].map(name=>[name,gl.getUniformLocation(program,name)]));
  gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);gl.clearColor(0,0,0,0);
  const motion=matchMedia('(prefers-reduced-motion: reduce)');let frame=0,visible=false,lost=false,last=0,time=0;
  function draw(now){
    frame=0;if(!visible||document.hidden||motion.matches||lost)return;
    if(now-last>=32){time+=Math.min(now-last,60)/1000;last=now;
      gl.clear(gl.COLOR_BUFFER_BIT);gl.uniform1f(uniforms.time,time);gl.uniform1f(uniforms.progress,Number(stage.dataset.modelProgress)||0);gl.uniform1f(uniforms.energy,Number(stage.dataset.modelEnergy)||0);gl.uniform1f(uniforms.aspect,canvas.clientWidth/Math.max(1,canvas.clientHeight));
      buffers.forEach((buffer,i)=>{gl.bindBuffer(gl.ARRAY_BUFFER,buffer);attributes.forEach(a=>{gl.enableVertexAttribArray(a.location);gl.vertexAttribPointer(a.location,a.size,gl.FLOAT,false,32,a.offset*4);});gl.uniform1f(uniforms.points,i);gl.drawArrays(i?gl.POINTS:gl.LINES,0,(i?dots:lines).length/8);});
    }frame=requestAnimationFrame(draw);
  }
  function sync(){cancelAnimationFrame(frame);frame=0;last=performance.now();if(visible&&!document.hidden&&!motion.matches&&!lost)frame=requestAnimationFrame(draw);}
  function resize(){const ratio=Math.min(devicePixelRatio||1,1.5);canvas.width=Math.round(canvas.clientWidth*ratio);canvas.height=Math.round(canvas.clientHeight*ratio);gl.viewport(0,0,canvas.width,canvas.height);sync();}
  new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;sync();}).observe(stage);
  canvas.addEventListener('webglcontextlost',()=>{lost=true;cancelAnimationFrame(frame);stage.classList.remove('market-model-ready');});
  motion.addEventListener('change',sync);document.addEventListener('visibilitychange',sync);new ResizeObserver(resize).observe(canvas);
  stage.classList.add('market-model-ready');resize();
})();
