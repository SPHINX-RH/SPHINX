/* Aratanagara engine: static paper meshes, GPU-side warp/front-back/lighting. */
'use strict';

const Aratanagara = {
  initialized:false,
  gl:null, prog:null, vao:null, vbo:null,
  aaProg:null, aaVAO:null, aaVBO:null, aaFbo:null, aaTex:null, aaW:0, aaH:0, depth:null, depthW:0, depthH:0,
  pieces:null, cap:0,
  strideFloats:22,

  init(gl){
    if(this.initialized) return;
    this.gl = gl;
    const vs = `#version 300 es
precision highp float;
in vec2 aLocal;
in vec4 aBase0; // ax, ay, az, seed
in vec4 aBase1; // len, wid, scale, curve
in vec4 aBase2; // rz, rx, ry, kind
in vec4 aBase3; // baseShade, orbitRadius, orbitRate, jumpAmp
in vec4 aExtra; // curveHand, twist, phase, morph
uniform vec2 uRes;
uniform float uTime;
uniform float uCamDist;   // カメラ距離倍率(web版で遠く)
uniform float uRoam;      // 群れ全体の大きな回遊(web版)
out vec3 vNormal;
out vec3 vWorld;
out float vBaseShade;
out float vKind;

// カール風の流れ場(ドメインワープした正弦の和)。渦・乱流で有機的に流れ、空間的に連続なので
// 近い個体は似た動き(群れの結束)、遠い個体は違う動き(自然なばらけ)になる。
vec3 flow(vec3 p, float t){
  vec3 a = p*0.8 + vec3(0.0, t*0.3, 0.0);
  vec3 d;
  d.x = sin(a.y*1.3 + t)     + 0.6*sin(a.z*2.1 - t*0.7);
  d.y = sin(a.z*1.1 - t*0.8) + 0.6*sin(a.x*1.7 + t*0.6);
  d.z = sin(a.x*1.2 + t*0.9) + 0.6*sin(a.y*1.9 - t*0.5);
  vec3 b = p*1.7 + d*0.9 + vec3(t*0.2);
  d.x += 0.55*sin(b.y*2.3 - t*1.1);
  d.y += 0.55*sin(b.z*2.1 + t*0.9);
  d.z += 0.55*sin(b.x*2.5 - t*1.0);
  vec3 c = p*3.4 + d*0.6 + vec3(t*0.45);          // 3オクターブ目: 細かい乱流を足して渦を強める
  d.x += 0.30*sin(c.y*3.3 + t*1.6);
  d.y += 0.30*sin(c.z*3.1 - t*1.5);
  d.z += 0.30*sin(c.x*3.6 + t*1.7);
  return d;
}
// 溜め→突き: 位相 ph[0,1) で「ゆっくり後退(溜め)→速く前進(突き)→戻り」。蛇のストライク。
float strikeMag(float ph){
  float coil = smoothstep(0.0, 0.55, ph);
  float fire = smoothstep(0.55, 0.66, ph);
  float relax = smoothstep(0.66, 1.0, ph);
  return mix(-0.6*coil, 1.0, fire) * (1.0 - relax);
}

void main(){
  float kind = aBase2.w;
  float isHero = step(0.5, kind) * (1.0 - step(1.5, kind));
  float isTrail = step(1.5, kind) * (1.0 - step(2.5, kind));
  float len = max(aBase1.x, 0.001);
  float wid = max(aBase1.y, 0.001);
  float u = clamp(aLocal.x / (len * 0.5), -1.0, 1.0);
  float v = clamp(aLocal.y / (wid * 0.5), -1.0, 1.0);
  // 流れ場に乗って飛ぶ。速度・加速度は流れ場の有限差分で求める(姿勢/バンク/トレイル切替に使う)。
  vec3 anchor = aBase0.xyz;
  float ft = uTime * 0.26;                                     // 流れの進行テンポ(乱流強めに合わせ少し速く)
  float fe = 0.05;
  vec3 f0 = flow(anchor, ft);
  vec3 f1 = flow(anchor, ft + fe);
  vec3 f2 = flow(anchor, ft + 2.0*fe);
  vec3 vel = (f1 - f0) / fe;                                   // 流れに沿う速度
  vec3 acc = (f2 - 2.0*f1 + f0) / (fe*fe);                     // 旋回(バンク用)
  float speed = length(vel);
  // 突風(場の強弱): 位置で位相をずらし群れを波が通り抜ける
  float gust = pow(0.5 + 0.5*sin(uTime*0.8 - (anchor.x*0.6 + anchor.z*0.5) - aBase0.w*0.15), 1.6);
  float moving = smoothstep(0.7, 2.4, speed);                 // 0=停滞 / 1=速く流れている
  float widthPulse = mix(0.88 + 0.12 * sin(uTime*0.55 + aExtra.z), 1.0, isTrail);
  vec2 local = vec2(aLocal.x, aLocal.y * widthPulse) * aBase1.z;
  float edgeFlow = (1.0 - isTrail) * smoothstep(0.18, 0.98, length(vec2(u, v*0.72)));
  edgeFlow = edgeFlow * edgeFlow * (3.0 - 2.0 * edgeFlow);
  float flowAmp = aBase1.x * aBase1.z * (0.054 + 0.032 * isHero);
  vec2 rippleXY = vec2(
    sin(uTime*0.64 + aExtra.z + u*1.85 + v*1.18),
    cos(uTime*0.58 + aBase0.w*0.09 + u*1.12 - v*1.66)
  ) * flowAmp * edgeFlow;
  local += rippleXY;   // ローカル名が関数 flow() を隠さないよう改名

  float sizeMetric = aBase1.x * aBase1.z;                                        // len*scale(大きさ)
  float smallBoost = mix(2.4, 0.6, smoothstep(0.18, 1.10, sizeMetric));          // 小さいかけらほど強烈にカール
  float twistBoost = mix(1.8, 0.75, smoothstep(0.18, 1.10, sizeMetric));         // 小さいかけらほど強烈にねじれ
  float curve = aBase1.w * aBase1.x * aBase1.z * (0.40 + 0.78 * pow(0.5 + 0.5*sin(uTime*0.5 + aExtra.z), 2.2)) * smallBoost;   // 鋭いピークで強烈に巻く
  vec3 p = vec3(
    local.x,
    local.y + aExtra.x * curve * (0.58*u*u - 0.15),
    curve * (1.30*u*u - 0.34) + local.y * aExtra.y * 0.055
  );
  // ひねり: エピソードごとに「ねじれて→緩んで原点(フラット)」を繰り返す。原点に戻るたび別のひねり方(向き/ねじれ率)へリセット。
  float twT = uTime * 0.30 + aExtra.z;   // ねじれをゆるやかに(遅く)
  float twN = floor(twT);
  float twEnv = sin(fract(twT) * 3.14159265);                  // 0→1→0(端=原点でフラット)
  float twH1 = fract(sin(twN*12.9898 + aBase0.w*7.13 + aExtra.w) * 43758.5453);
  float twH2 = fract(sin(twN* 4.1414 + aBase0.w*2.71) * 43758.5453);
  float twRate = mix(0.55, 1.7, twH2);                         // 長手方向のねじれ率(ピーク強烈に)
  float twDir  = (twH1 < 0.5 ? -1.0 : 1.0);                    // 向き(エピソードごとに反転しうる)
  float bodyTwist = u * twRate * twDir * (0.6 + twH1*1.05) * twEnv * twistBoost;   // ピーク時に大きくねじれる(小片ほど強)
  p.yz = mat2(cos(bodyTwist), -sin(bodyTwist), sin(bodyTwist), cos(bodyTwist)) * p.yz;
  float dynScale = 1.0 + (0.09 + isHero*0.10 + aBase3.w*0.020) * sin(uTime*0.48 + aExtra.w);
  p *= dynScale;

  vec3 tangent = normalize(vec3(
    1.0,
    aExtra.x * aBase1.w * u * 0.88 * smallBoost,
    aBase1.w * u * 1.34 * smallBoost
  ));
  vec3 widthDir = normalize(vec3(0.0, 1.0, aExtra.y * 0.055));
  vec3 n = normalize(cross(tangent, widthDir));
  n.yz = mat2(cos(bodyTwist), -sin(bodyTwist), sin(bodyTwist), cos(bodyTwist)) * n.yz;

  // ---- 進行方向(流れ)で姿勢を決める。旋回で内側にバンク、突風・高速でフラッター ----
  vec3 fwd = normalize(vel + vec3(0.0001, 0.0, 0.0));
  fwd = normalize(fwd + vec3(-fwd.z, 0.0, fwd.x) * (sin(uTime*0.5 + aBase0.w) * 0.08));   // 個体差の首振り
  vec3 rgt = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 upv = cross(fwd, rgt);
  // 進行方向に垂直な軸(rgt)まわりのタンブル: 紙片が空気を受けて end-over-end に回る。
  // 個体ごとに一定速度 + 乱流(gust)・高速で揺らぐ。自然な軸の一貫した回転なのでランダムには見えない。trailは線が乱れるので回さない。
  float tumbleNT = (1.0 - isTrail*0.92) * smoothstep(1.5, 0.25, aBase1.x*aBase1.z);   // 大きいシェイプほど反転しにくい
  float pitchT = (uTime*(1.0 + aExtra.w*0.30) + aBase0.w*2.1) * tumbleNT
               + (gust*1.6 + moving*0.5) * sin(uTime*0.7 + aBase0.w*1.3) * tumbleNT;
  float cpT = cos(pitchT), spT = sin(pitchT);
  vec3 fwdT = fwd*cpT + upv*spT;
  upv = -fwd*spT + upv*cpT;
  fwd = fwdT;
  // 軸をゆっくり揺らす(歳差)= 単軸より自然な不規則タンブル
  float yawT = (uTime*(0.40 + aExtra.w*0.12) + aBase0.w*1.7) * tumbleNT;
  float cyT = cos(yawT), syT = sin(yawT);
  vec3 fwdY = fwd*cyT + rgt*syT;
  rgt = -fwd*syT + rgt*cyT;
  fwd = fwdY;
  float bank = clamp(dot(acc, rgt) * 0.16, -1.0, 1.0);          // 旋回(横加速度)で内側に傾く
  float flutterAmp = 0.15 + isHero*0.04 + gust*0.60 + moving*0.18;   // 突風・高速で激しく翻る
  float flutter = sin(uTime*(2.0 + aBase3.z*0.9 + isTrail*0.6) + aExtra.z) * flutterAmp;
  float roll = bank + flutter + aBase2.x*0.15;
  float cr = cos(roll), sr = sin(roll);
  vec3 rgtB = rgt*cr + upv*sr;
  vec3 upvB = -rgt*sr + upv*cr;
  // ローカル軸 → 機体軸: x=長手→fwd, y=幅→rgtB(バンク), z=面法線→upvB
  p = p.x*fwd + p.y*rgtB + p.z*upvB;
  n = n.x*fwd + n.y*rgtB + n.z*upvB;

  // ---- 位置: 群れ内の定位置(anchor)+ 流れ場の変位。小さいほど中心に密集 ----
  float smallF = 1.0 - smoothstep(0.20, 0.55, aBase1.x * aBase1.z);
  float spreadScale = mix(1.0, 0.45, smallF);
  float dispScale   = mix(1.0, 0.62, smallF);
  float dispA = 0.62 * (0.7 + 0.6*gust);
  vec3 disp = f0 * dispA;                                       // 流れ場の変位(突風で大きく流れる)
  vec3 world = p + anchor*0.95*spreadScale + disp*dispScale;

  // ---- 追従線 = 蛇/ムチ: 頭(u=+1)が現在の流れ位置を先導、胴体は頭の通った軌跡を後ろから辿ってしなる ----
  if(isTrail > 0.5){
    float tspan = 3.2;                                          // 胴体が辿る過去の長さ(flow時間)
    float headU = u*0.5 + 0.5;                                  // 0(尾)..1(頭)
    float to = (1.0 - headU) * tspan;                           // 頭=0 → 尾=tspan 過去
    vec3 cc = anchor*0.95*spreadScale + flow(anchor, ft - to) * dispA;          // 中心線(過去の頭位置)
    vec3 cf = anchor*0.95*spreadScale + flow(anchor, ft - to + 0.07) * dispA;   // 頭寄り(接線用)
    vec3 tg = normalize(cf - cc + vec3(0.0001, 0.0, 0.0));
    // 溜め→突き: 各点の過去位相で頭方向へ -溜め→+突き(頭ほど強い)
    float spp = fract((ft - to) * 0.5 + aBase0.w*0.5);
    cc += tg * strikeMag(spp) * 0.55 * (0.4 + 0.6*headU);
    vec3 sd = normalize(cross(tg, vec3(0.0,1.0,0.0)) + vec3(0.0001,0.0,0.0));
    world = cc + sd * (aLocal.y * aBase1.z);                    // 幅(テーパー込み)を側方へ
    n = normalize(cross(sd, tg));                              // リボン法線
  }
  // カメラ: 画面中心(群れの重心)を一定周回(緩急はつけるが逆回りはしない)。距離を取って公転が分かるように。
  float cam = 1.10 + uTime*0.7854 + sin(uTime*0.07)*0.30;        // 一周=8秒(2π/8)。微小な緩急つき・常に同方向
  float camR = (3.05 + sin(uTime*0.05)*0.35) * uCamDist;        // 距離を取る + 軽い寄り引き(web版は遠く)
  vec3 eye = vec3(cos(cam)*camR, 0.45 + sin(uTime*0.09)*0.30, sin(cam)*camR);
  vec3 target = vec3(0.28, 0.06, 0.0);   // 群れの重心(やや右寄り)を見て画面に収める
  vec3 forward = normalize(target - eye);
  vec3 right = normalize(cross(vec3(0.0,1.0,0.0), forward));
  vec3 up = cross(forward, right);
  vec3 rel = world - eye;
  world = vec3(dot(rel, right), dot(rel, up), dot(rel, forward));
  // 回遊(web版): view空間で画面を大きく横断+奥へ。手前(eye側)には来ないのでカメラと衝突しない。
  world.x += uRoam * sin(uTime*0.16) * 3.4;
  world.y += uRoam * sin(uTime*0.12 + 1.7) * 1.4;
  world.z += uRoam * (1.0 - cos(uTime*0.10)) * 1.5;
  float zSpread = uCamDist + uRoam * 1.6;                        // 回遊で奥行きが伸びる分も深度に含める
  float persp = clamp(2.20 / max(0.72, world.z), 0.58, 1.40);   // 近接ピースの過剰拡大を抑える
  world.xy *= persp;
  vNormal = normalize(vec3(dot(n, right), dot(n, up), dot(n, forward)));
  vWorld = world;
  vBaseShade = aBase3.x;
  vKind = kind;

  float aspect = uRes.x / max(uRes.y, 1.0);
  float heroScale = 1.0 + isHero*0.18 + isTrail*0.08;
  vec2 screen = vec2(world.x / aspect, world.y) * 1.00 * heroScale;   // 距離感を出す(やや引き)
  gl_Position = vec4(screen, clamp((world.z - 2.20*uCamDist) * (0.30/zSpread), -0.92, 0.92), 1.0);
}`;
    const fs = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in float vBaseShade;
in float vKind;
uniform float uAlpha;
uniform float uHiOnly;   // 1=影を落とさずハイライトのみ(web版)
uniform float uFog;      // 大気遠近の強さ(web版)
uniform float uCamDist;  // カメラ距離倍率(fogレンジ補正用)
out vec4 o;
void main(){
  vec3 nn = normalize(vNormal);
  if(!gl_FrontFacing) nn = -nn;
  vec3 l1 = normalize(vec3(-0.42,0.72,0.56));
  vec3 l2 = normalize(vec3(0.64,-0.20,0.62));
  float d1 = max(0.0, dot(nn,l1));
  float d2 = max(0.0, dot(nn,l2));
  vec3 viewDir = normalize(vec3(-vWorld.xy*0.24, 1.0));
  float spec1 = pow(max(0.0, dot(reflect(-l1, nn), viewDir)), 30.0);
  float spec2 = pow(max(0.0, dot(reflect(-l2, nn), viewDir)), 46.0);
  float rim = pow(max(0.0, 1.0 - abs(nn.z)), 1.45);
  float band = 0.5 + 0.5 * sin(vWorld.x*5.2 - vWorld.y*2.7 + vWorld.z*6.4 + nn.x*3.0);
  float light = clamp(0.11 + vBaseShade*0.14 + d1*0.50 + d2*0.22 + rim*0.16 + band*0.08, 0.04, 1.0);   // 環境光を下げ両面のシャドウを濃く(以前の色味へ)
  float metal = clamp(0.38 + abs(nn.z)*0.36 + nn.x*0.18 - nn.y*0.10 + band*0.28, 0.0, 1.0);
  vec3 greenBase = vec3(0.020,0.380,0.080);
  vec3 greenShadow = greenBase * (0.32 + 0.78 * light);
  greenShadow = mix(vec3(0.003,0.030,0.008), greenShadow, smoothstep(0.04, 0.92, light));
  vec3 green = mix(greenShadow, greenBase * 0.96, uHiOnly);
  green *= 0.88 + 0.16 * band;
  float greenHi = pow(max(0.0, d1*0.64 + rim*0.58 + band*0.10), 2.5);
  float greenEdge = pow(rim, 2.2) * (0.38 + d1*0.62);
  green += vec3(0.05,0.55,0.12) * greenHi * mix(0.05, 0.32, uHiOnly);
  green += vec3(0.15,0.85,0.20) * (spec1*0.03 + spec2*0.02 + greenEdge*0.03) * mix(1.0, 3.5, uHiOnly);
  green += vec3(0.015,0.120,0.030) * pow(max(0.0, band), 5.5) * 0.55;

  float isBig = step(0.5, vKind) * (1.0 - step(1.5, vKind));
  float mirrorFreq = mix(34.0, 14.0, isBig);
  float worldFreq = mix(1.0, 0.42, isBig);
  float mirror = sin(metal * mirrorFreq + light * 5.2 + (vWorld.x*9.0 - vWorld.y*5.0) * worldFreq) * 0.5 + 0.5;
  float stripe = smoothstep(0.58,0.86,mirror);
  float glint = pow(max(0.0, mirror), mix(40.0, 22.0, isBig));
  float rimChrome = pow(rim, 2.0) * (0.40 + 0.60*d2);
  vec3 chrome = mix(vec3(0.030,0.034,0.046), vec3(0.58,0.66,0.78), pow(light, 1.5));   // 裏面クロームは常に元のまま(影あり)
  chrome = mix(chrome, vec3(0.165,0.180,0.215), pow(1.0-mirror, 3.0) * 0.12);
  chrome = mix(chrome, vec3(0.82,0.91,1.00), stripe * 0.52);
  chrome += vec3(0.95,0.98,1.00) * (spec1*0.50 + spec2*0.42 + rimChrome*0.24);
  chrome = mix(chrome, vec3(1.00,1.00,0.96), glint * 0.62);

  vec3 col = gl_FrontFacing ? green : chrome;
  // 空気遠近(view空間z): 奥ほど(1) 手前ほど(0)
  float depth = smoothstep(2.0*uCamDist, 4.8*uCamDist, vWorld.z);
  float k = clamp(depth * uFog, 0.0, 1.0);
  vec3 bg = vec3(0.690,0.733,0.800);
  float luma = dot(col, vec3(0.299,0.587,0.114));
  col = mix(col, mix(vec3(luma), bg, 0.5), k * 0.62);   // 手前以外はコントラストを弱く(平坦化)
  col = mix(col, bg, k * 0.62);                          // 背景へフェード(空気遠近)
  o = vec4(clamp(col,0.0,1.0), uAlpha);
}`;
    const sh = (type, src)=>{
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if(!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p;
    const aaVs = `#version 300 es
layout(location=0) in vec2 a;
out vec2 vUv;
void main(){ vUv = a*0.5+0.5; gl_Position = vec4(a,0.0,1.0); }`;
    const aaFs = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
out vec4 o;
const float EDGE_MIN = 1.0/128.0;
const float EDGE_MAX = 1.0/8.0;
const float SPAN_MAX = 8.0;
float lum(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
vec4 pm(vec4 c){ return vec4(c.rgb*c.a, c.a); }
vec4 unpm(vec4 c){ return c.a > 0.0001 ? vec4(c.rgb/c.a, c.a) : vec4(0.0); }
void main(){
  vec4 c4  = texture(uTex, vUv);
  vec4 nw4 = texture(uTex, vUv + vec2(-1.0,-1.0)*uTexel);
  vec4 ne4 = texture(uTex, vUv + vec2( 1.0,-1.0)*uTexel);
  vec4 sw4 = texture(uTex, vUv + vec2(-1.0, 1.0)*uTexel);
  vec4 se4 = texture(uTex, vUv + vec2( 1.0, 1.0)*uTexel);
  vec3 c = c4.rgb, nw = nw4.rgb, ne = ne4.rgb, sw = sw4.rgb, se = se4.rgb;
  float lc = lum(c), lnw = lum(nw), lne = lum(ne), lsw = lum(sw), lse = lum(se);
  float lmin = min(lc, min(min(lnw, lne), min(lsw, lse)));
  float lmax = max(lc, max(max(lnw, lne), max(lsw, lse)));
  vec2 dir = vec2(-((lnw + lne) - (lsw + lse)), ((lnw + lsw) - (lne + lse)));
  float dirRed = max((lnw + lne + lsw + lse) * 0.25 * EDGE_MAX, EDGE_MIN);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirRed);
  dir = clamp(dir * rcpMin, vec2(-SPAN_MAX), vec2(SPAN_MAX)) * uTexel;
  vec4 a = 0.5 * (pm(texture(uTex, vUv + dir*(1.0/3.0 - 0.5)))
                + pm(texture(uTex, vUv + dir*(2.0/3.0 - 0.5))));
  vec4 b = a*0.5 + 0.25*(pm(texture(uTex, vUv + dir*-0.5))
                       + pm(texture(uTex, vUv + dir* 0.5)));
  vec4 bu = unpm(b);
  float lb = lum(bu.rgb);
  o = unpm((lb < lmin || lb > lmax) ? a : b);
}`;
    const aaP = gl.createProgram();
    gl.attachShader(aaP, sh(gl.VERTEX_SHADER, aaVs));
    gl.attachShader(aaP, sh(gl.FRAGMENT_SHADER, aaFs));
    gl.linkProgram(aaP);
    if(!gl.getProgramParameter(aaP, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(aaP));
    this.aaProg = aaP;
    this.aaVAO = gl.createVertexArray();
    this.aaVBO = gl.createBuffer();
    gl.bindVertexArray(this.aaVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.aaVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.pieces = Array.from({length: this.pieceCount || 48}, (_, i)=>this._piece(i));
    const data = this._buildStatic();
    this.cap = data.length / this.strideFloats;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const stride = this.strideFloats * 4;
    const attrs = [
      ['aLocal', 2, 0],
      ['aBase0', 4, 2],
      ['aBase1', 4, 6],
      ['aBase2', 4, 10],
      ['aBase3', 4, 14],
      ['aExtra', 4, 18],
    ];
    for(const [name,size,offset] of attrs){
      const loc = gl.getAttribLocation(p, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
    }
    gl.bindVertexArray(null);
    this.initialized = true;
  },

  _hash(n){
    const x = Math.sin(n) * 43758.5453123;
    return x - Math.floor(x);
  },

  _piece(i){
    const h = n=>this._hash(i * 43.71 + n * 9.13);
    const fixed = [
      {kind:'hero',  x:0.82,  y:0.10,  z:0.02, len:1.78, wid:1.25, scale:1.34, rz:0.16,  rx:0.10,  ry:2.55, curve:0.54},
      {kind:'hero',  x:-0.78, y:-0.36, z:0.18, len:1.30, wid:1.07, scale:1.20, rz:-0.58, rx:0.16,  ry:1.75, curve:0.76},
      {kind:'blade', x:-0.30, y:-0.08, z:0.34, len:1.85, wid:0.105,scale:0.95, rz:0.58,  rx:0.10,  ry:1.25, curve:0.28},
      {kind:'blade', x:0.55,  y:0.30,  z:-0.08,len:1.62, wid:0.075,scale:0.82, rz:-0.30, rx:-0.08, ry:2.15, curve:0.32},
      {kind:'blade', x:-1.02, y:-0.52, z:0.02, len:1.34, wid:0.070,scale:0.76, rz:0.90,  rx:0.22,  ry:0.65, curve:0.42},
      {kind:'blade', x:1.12,  y:0.42,  z:0.20, len:1.52, wid:0.060,scale:0.74, rz:0.62,  rx:-0.20, ry:2.85, curve:0.36},
      {kind:'trail', x:-0.90, y:0.34,  z:0.42, len:2.10, wid:0.009,scale:0.92, rz:0.94,  rx:0.06,  ry:0.82, curve:0.82},
      {kind:'trail', x:0.36,  y:0.55,  z:0.26, len:1.90, wid:0.008,scale:0.85, rz:-0.78, rx:-0.12, ry:2.60, curve:0.72},
      {kind:'trail', x:0.72,  y:-0.36, z:-0.16,len:2.22, wid:0.008,scale:0.88, rz:0.18,  rx:0.22,  ry:1.85, curve:0.78},
      {kind:'trail', x:-0.18, y:-0.62, z:0.30, len:1.74, wid:0.007,scale:0.78, rz:-0.38, rx:0.18,  ry:1.30, curve:0.92},
      {kind:'trail', x:-0.56, y:0.08,  z:-0.22,len:1.86, wid:0.007,scale:0.74, rz:0.34,  rx:-0.18, ry:2.20, curve:0.86},
      {kind:'trail', x:0.98,  y:-0.10, z:0.36, len:2.04, wid:0.008,scale:0.82, rz:-0.52, rx:0.14,  ry:0.96, curve:0.74}
    ][i];
    let kind = fixed ? fixed.kind : 'zigzag';
    if(!fixed){
      const kr = h(1.0);
      kind = kr < 0.50 ? 'zigzag' : kr < 0.75 ? 'tri' : 'quad';   // 不規則多角形(交差なし)/三角/四角を混在(最大7頂点)
    }
    const sr = h(2.0);
    const tier = sr < 0.40 ? 0 : sr < 0.888 ? 1 : 2;   // サイズ層: 0=小 / 1=中 / 2=大シャード(5枚)
    const small = tier === 0;                          // 既存の small 参照(密集など)を維持
    if(!fixed && tier === 2) kind = 'tri';   // 大きいシェイプは三角形
    const len = fixed ? fixed.len : tier===0 ? 0.22 + h(3.8)*0.20 : tier===1 ? 0.48 + h(4.2)*0.36 : 0.92 + h(4.6)*0.42;
    const wid = fixed ? fixed.wid : tier === 2 ? 0.50 + h(6.2)*0.45 : len * (0.72 + h(5.9)*0.34);   // 小〜中の破片は2D化(幅をlen比に)
    const kindId = kind === 'hero' ? 1 : kind === 'trail' ? 2 : kind === 'blade' ? 3 : kind.indexOf('concave') === 0 ? 4 : 0;
    const pc = {
      seed:i, kind, kindId, small, len, wid,
      baseShade:0.58 + h(6.0) * 0.34,
      ax:fixed ? fixed.x : (h(10.8)-0.5)*2.7,
      ay:fixed ? fixed.y : (h(11.2)-0.5)*1.7,
      az:fixed ? fixed.z : (h(11.6)-0.5)*1.0,
      baseScale:fixed ? fixed.scale : tier===0 ? 0.50 + h(12.0)*0.22 : tier===1 ? 0.66 + h(12.4)*0.26 : 0.86 + h(12.6)*0.22,
      baseRz:fixed ? fixed.rz : (h(12.8)-0.5)*2.5,
      baseRx:fixed ? fixed.rx : (h(13.2)-0.5)*0.55,
      baseRy:fixed ? fixed.ry : (h(13.6)-0.5)*2.80,
      curvePhase:h(6.4) * Math.PI * 2,
      curveHand:h(6.8) > 0.5 ? 1 : -1,
      curveAmt:(fixed ? fixed.curve : kind === 'blade' ? 0.42 : 0.50) + h(7.2) * 0.28,
      twistAmt:(kind === 'trail' ? 0.86 : kind === 'blade' ? 0.42 : 0.58) + h(7.6) * 0.46,
      orbitRadius:fixed
        ? (kind === 'hero' ? 0.42 + h(8.2) * 0.28 : kind === 'trail' ? 0.34 + h(8.4) * 0.26 : 0.30 + h(8.6) * 0.24)
        : (tier===0 ? 0.28 + h(8.8)*0.28 : tier===1 ? 0.40 + h(9.0)*0.36 : 0.46 + h(9.1)*0.40),
      orbitRate:0.34 + h(9.2) * 0.42,
      jumpAmp:fixed ? 0.92 : 1.18 + h(10.2) * 1.05,
      morph:h(10.4) * Math.PI * 2
    };
    pc.shape = this._shape(pc, h);
    return pc;
  },

  _shape(pc, h){
    if(pc.kind === 'trail'){
      const l = pc.len * 0.5, w = pc.wid * 0.5;
      return [[-l,-w], [l,-w*0.72], [l,w*0.72], [-l,w]];
    }
    if(pc.kind === 'blade'){
      const l = pc.len * 0.5, w = pc.wid * 0.58;
      return [[-l,-w*0.22], [l*0.62,-w], [l,-w*0.10], [l*0.18,w], [-l,w*0.34]];
    }
    if(pc.kind === 'hero'){
      const l = pc.len * 0.5, w = pc.wid * 0.62;
      if(pc.seed % 2 === 0) return [[-l,-w*0.82], [l,-w*0.04], [-l*0.38,w]];   // 三角形
      return [[-l,-w*0.78], [l,-w*0.02], [-l*0.52,w]];                          // 三角形
    }
    if(pc.kind === 'tri'){
      const l = pc.len * 0.5, w = pc.wid * 0.60;
      return [[-l,-w*0.70], [l,-w*0.02], [-l*0.48,w]];
    }
    if(pc.kind === 'quad'){
      const l = pc.len * 0.5, w = pc.wid * 0.52;
      return [[-l*0.92,-w*0.80], [l*0.96,-w*0.40], [l*0.72,w*0.94], [-l*0.84,w*0.62]];
    }
    if(pc.kind === 'zigzag'){
      const rl = pc.len * 0.5, rw = pc.wid * 0.5;
      const n = 4 + Math.floor(h(14.0) * 4);            // 4〜7頂点
      const step = 6.2831853 / n;
      const pts = [];
      for(let k = 0; k < n; k++){
        // 角度順を保つ(交差しない) + 角度/半径をジッタしてジグザグな凹凸に
        const a = k * step + (h(14.2 + k*0.6) - 0.5) * step * 0.6 + pc.morph;
        const r = 0.42 + h(14.5 + k*0.6) * 0.58;        // 半径ジッタ(凹凸)
        pts.push([Math.cos(a) * rl * r, Math.sin(a) * rw * r]);
      }
      return pts;
    }
    const l = pc.len * 0.5, w = pc.wid * 0.58;
    return [[-l,-w], [l*0.96,-w*0.20], [l*0.18,w], [-l*0.72,w*0.54]];
  },

  _pushVertex(out, p, pc){
    out.push(
      p[0], p[1],
      pc.ax, pc.ay, pc.az, pc.seed,
      pc.len, pc.wid, pc.baseScale, pc.curveAmt,
      pc.baseRz, pc.baseRx, pc.baseRy, pc.kindId,
      pc.baseShade, pc.orbitRadius, pc.orbitRate, pc.jumpAmp,
      pc.curveHand, pc.twistAmt, pc.curvePhase, pc.morph
    );
  },

  _pushTri(out, a, b, c, pc){
    this._pushVertex(out, a, pc);
    this._pushVertex(out, b, pc);
    this._pushVertex(out, c, pc);
  },

  _buildTrail(out, pc){
    const n = 160, hw = pc.wid * 0.5;
    for(let i=0; i<n; i++){
      const u0=i/n, u1=(i+1)/n;
      const x0=(u0-0.5)*pc.len, x1=(u1-0.5)*pc.len;
      const w0=hw*(0.46+0.70*Math.sin(u0*Math.PI));
      const w1=hw*(0.46+0.70*Math.sin(u1*Math.PI));
      this._pushTri(out, [x0,-w0], [x1,-w1], [x1,w1], pc);
      this._pushTri(out, [x0,-w0], [x1,w1], [x0,w0], pc);
    }
  },

  _buildShape(out, pc){
    const rings = pc.kind === 'hero'
      ? [0,0.09,0.18,0.27,0.36,0.45,0.55,0.64,0.73,0.82,0.91,1]
      : pc.kind === 'blade'
        ? [0,0.08,0.16,0.25,0.34,0.43,0.52,0.61,0.70,0.79,0.87,0.94,1]
        : [0,0.10,0.20,0.30,0.40,0.50,0.60,0.70,0.80,0.90,1];
    const edgeN = pc.kind === 'hero' ? 16 : pc.kind === 'blade' ? 20 : pc.kind === 'zigzag' ? 6 : 18;
    for(let j=0; j<pc.shape.length; j++){
      const a=pc.shape[j], b=pc.shape[(j+1)%pc.shape.length];
      for(let ei=0; ei<edgeN; ei++){
        const e0=ei/edgeN, e1=(ei+1)/edgeN;
        const q0=[a[0]+(b[0]-a[0])*e0, a[1]+(b[1]-a[1])*e0];
        const q1=[a[0]+(b[0]-a[0])*e1, a[1]+(b[1]-a[1])*e1];
        for(let ri=0; ri<rings.length-1; ri++){
          const r0=rings[ri], r1=rings[ri+1];
          const p00=[q0[0]*r0, q0[1]*r0];
          const p01=[q1[0]*r0, q1[1]*r0];
          const p10=[q0[0]*r1, q0[1]*r1];
          const p11=[q1[0]*r1, q1[1]*r1];
          this._pushTri(out, p00, p10, p11, pc);
          this._pushTri(out, p00, p11, p01, pc);
        }
      }
    }
  },

  _buildStatic(){
    const out = [];
    for(const pc of this.pieces){
      if(pc.kind === 'trail') this._buildTrail(out, pc);
      else this._buildShape(out, pc);
    }
    return new Float32Array(out);
  },

  _ensureDepth(w,h){
    const gl = this.gl;
    if(!this.depth) this.depth = gl.createRenderbuffer();
    if(this.depthW === w && this.depthH === h) return;
    this.depthW = w; this.depthH = h;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
  },

  _ensureAA(w,h){
    const gl = this.gl;
    if(!this.aaTex){
      this.aaTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.aaTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.aaFbo = gl.createFramebuffer();
    }
    if(this.aaW !== w || this.aaH !== h){
      this.aaW = w; this.aaH = h;
      gl.bindTexture(gl.TEXTURE_2D, this.aaTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.aaFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.aaTex, 0);
  },

  _applyAA(fbo,w,h){
    const gl = this.gl;
    if(!this.aaProg || !this.aaTex) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0,0,w,h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.aaProg);
    gl.bindVertexArray(this.aaVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.aaTex);
    gl.uniform1i(gl.getUniformLocation(this.aaProg,'uTex'), 0);
    gl.uniform2f(gl.getUniformLocation(this.aaProg,'uTexel'), 1 / w, 1 / h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  },

  render({fbo,w,h,slot}){
    const gl = this.gl;
    this._ensureDepth(w,h);
    this._ensureAA(w,h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.aaFbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    gl.viewport(0,0,w,h);
    const opaque = slot === 'A';
    gl.clearColor(0.690,0.733,0.800, opaque ? 1 : 0);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform2f(gl.getUniformLocation(this.prog,'uRes'), w, h);
    gl.uniform1f(gl.getUniformLocation(this.prog,'uTime'), (typeof GL !== 'undefined' ? GL.clock : performance.now()/1000));
    gl.uniform1f(gl.getUniformLocation(this.prog,'uAlpha'), 1);
    gl.uniform1f(gl.getUniformLocation(this.prog,'uHiOnly'), this.highlightOnly ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.prog,'uFog'), this.fogAmt || 0);
    gl.uniform1f(gl.getUniformLocation(this.prog,'uCamDist'), this.camDist || 1.0);
    gl.uniform1f(gl.getUniformLocation(this.prog,'uRoam'), this.roam || 0.0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.cap);
    gl.bindVertexArray(null);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
    this._applyAA(fbo,w,h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST);
  }
};

window.Aratanagara = Aratanagara;
