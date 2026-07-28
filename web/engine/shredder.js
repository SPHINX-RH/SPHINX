'use strict';
/* Shredder engine — vj/ の追加レンダリングモード (kind:'shredder')。
   元ネタ: clicktorelease.com/code/polygon-shredder (Jaume Sanchez) の GPGPU パーティクル。
   カール(渦)ノイズで流れる位置を float テクスチャに保持し、1 粒ごとに「鋭利な多角形の破片」を
   インスタンス描画する。原作の長方形の帯ではなく、原点を貫いて互いに交差する三角形の刃にした。
   配色は aratanagara 準拠 (表=ディープブルー / 裏=クローム / 明るいグレーの空気遠近)。
   - 既存の vj WebGL2 コンテキストを共有 / 指定 FBO に描画 → 通常の合成・Post FX に合流
   - Drone/Beat モード対応 (拍で流速と刃の伸びをキック)
   IF: init(gl) / update() / render({fbo,w,h,slot,beat,clock,opaque}) / P(params)
*/

const Shredder = {
  gl:null, initialized:false,
  simProg:null, drawProg:null,
  simVAO:null, simVBO:null,
  drawVAO:null, bladeVBO:null, idVBO:null,
  sim:null,               // {w,h,tex:[2],fbo:[2],cur} ping-pong
  seedTex:null,           // 初期位置(再生成先)
  depthRBO:null, depthW:0, depthH:0,
  bladeVerts:0, instances:0,
  startTime:0, lastClock:0, beatPulse:0,
  cam:{az:0.0, el:0.16},

  // ── パラメータ (UI から操作) ──
  P:{
    grid:56,           // 粒の数 = grid×grid (56 → 3136)
    scale:1.7,         // 破片の大きさ
    spike:2.4,         // 刃の伸び (流れ方向への尖り)
    blades:3,          // 1 粒あたりの刃(三角形)の枚数
    twist:0.55,        // 刃ごとの捻り
    speed:1.0,         // 流れの速さ
    evolution:0.5,     // 流れ場が変化する速さ
    turbulence:1.0,    // カールノイズの空間周波数 (大=細かい渦)
    radius:1.5,        // この半径より内側には入らない (中心の空洞)
    outflow:0.42,      // 外へ吹き出す量 (0=カールのみ=球殻に張り付く)
    flock:0.35,        // 群れ感 (0=個々バラバラの細かい渦 / 1=全員が同じ大きな流れ)
    cohesion:0.25,     // 凝集 (大きい=固まりを保つ / 0=どこまでも散る)
    speedVar:0.35,     // 個体ごとの速度ばらつき (0=全員同速)
    inertia:0.88,      // 旋回の滑らかさ (0=流れ場に即追従して急旋回 / 1=大きく緩やかに曲がる)
    aim:0,             // 尖りの向き 0=進行方向 1=後ろ 2=外 3=中心 4=進行方向(画面内) 5=個体固定
    shapeRand:0.55,    // 形状のランダムさ (角の数・長さ・幅・非対称さ)
    bend:0.35,         // 進行方向への曲げ (先端ほど反る。負で逆へ)
    bendTurn:0.6,      // 曲げの向き 0=個体ごと固定 / 1=実際の旋回方向へ
    spinRate:0.6,      // 破片の自転の速さ
    spinVar:0.5,       // 自転速度の個体差
    path:2,            // 群れの中心が描く軌跡 0=なし 1=円 2=∞ 3=リサージュ 4=結び目 5=8の字(縦)
    pathSize:2.6,      // 軌跡の大きさ
    pathRate:0.35,     // 軌跡を進む速さ
    pathPull:0.55,     // 中心への追従の強さ
    camFollow:1.0,     // カメラが中心を追う量 (0=原点固定)
    emitter:0,         // 湧き出し 0=空間全体 1=中心の球殻 2=外殻から中へ 3=中心の点
    swirl:0.25,        // 粒の周回 (中心まわりの旋回。負で逆回転)
    swirlTilt:0.0,     // 周回軸の傾き
    orbitTilt:0.12,    // カメラ仰角の首振り幅
    orbitTiltRate:0.3, // 首振りの速さ
    orbitEllip:0.0,    // 楕円軌道 (距離の変化幅)
    hue:0.0,           // 表面色の色相回転 (0=aratanagara のブルー / 1.0 で一周)
    sat:1.0,           // 表面色の彩度 (0=グレー)
    chrome:1.0,        // 裏面のクローム量 (0=表と同じ色 / 1=クローム)
    blueLight:1.0,     // 表(ブルー)の明度
    chromeLight:1.0,   // 裏(クローム)の明度
    chromeCon:1.3,     // クロームのコントラスト (aratanagara の帯が立つ値。黒つぶれは Floor が防ぐ)
    chromeFloor:0.12,  // クロームの黒つぶれ持ち上げ (下限の明るさ)
    stripeFreq:34,     // 反射帯: 面の向きに対する周波数 (aratanagara=34)
    stripeScale:1.0,   // 反射帯: 空間周期の倍率 (下げると帯が太く大きく)
    stripeAmt:0.52,    // 反射帯の濃さ
    stripeW:0.5,       // 反射帯の幅 (0=極細のライン / 1=ぼんやり広い)
    glintAmt:0.62,     // グリント (帯の芯の白い抜け) の量
    glintSharp:40,     // グリントの鋭さ (大きいほど細く鋭い)
    specAmt:1.0,       // スペキュラ + 縁光りの量
    nearFade:2.0,      // カメラ至近を透明化する距離 (0=しない)
    nearMode:0,        // 至近の処理 0=透明度 1=ディザ 2=背景へ溶かす 3=なし
    nearCull:0.55,     // カメラ至近の破片を縮めて消す距離
    bgLight:1.0,       // 背景の明るさ (0=チャコール / 1=明るいグレー)
    shape:0,           // 刃の形 0=三角 1=矢 2=針 3=薄片 4=十字
    colorMode:0,       // 配色 0=aratanagara 1=モノクローム 2=表裏同色 3=速度で色相
    camPath:0,         // カメラ経路 0=周回 1=螺旋 2=静止 3=ドリフト
    life:170,          // 寿命フレーム (短い=絶えず湧き直す)
    fov:95, dist:6.2, camEl:0.16,   // 広角レンズ (寄って広く写す = 遠近が強調される)
    fisheye:0.35,      // 樽型歪み (0=直線的な広角 / 1=強い魚眼)
    autorot:0.18,      // カメラ自動公転
    fog:0.85,          // 空気遠近の強さ
    fogNear:0.85,      // 霞み始める距離 (カメラ距離に対する比率)
    fogFar:2.1,        // 完全に霞む距離 (同)
    beatKick:0.4,      // 拍での流速/伸びキック
    seed:11,
  },

  // ===== math =====
  m4:{
    mul(a,b){ const o=new Float32Array(16); for(let c=0;c<4;c++)for(let r=0;r<4;r++){let s=0;for(let k=0;k<4;k++)s+=a[k*4+r]*b[c*4+k];o[c*4+r]=s;} return o; },
    persp(fov,asp,n,f){ const t=1/Math.tan(fov*0.5), nf=1/(n-f); return new Float32Array([t/asp,0,0,0, 0,t,0,0, 0,0,(f+n)*nf,-1, 0,0,2*f*n*nf,0]); },
    lookAt(e,c,u){ const z=Shredder._norm([e[0]-c[0],e[1]-c[1],e[2]-c[2]]);
      const x=Shredder._norm(Shredder._cross(u,z)); const y=Shredder._cross(z,x);
      return new Float32Array([x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
        -Shredder._dot(x,e),-Shredder._dot(y,e),-Shredder._dot(z,e),1]); },
  },
  _cross(a,b){ return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; },
  _dot(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; },
  _norm(a){ const l=Math.hypot(a[0],a[1],a[2])||1; return [a[0]/l,a[1]/l,a[2]/l]; },
  _rng(seed){ let s=seed>>>0||1; return ()=>{ s^=s<<13; s^=s>>>17; s^=s<<5; s>>>=0; return s/4294967296; }; },

  // ===== init =====
  init(gl){
    if(this.initialized) return;
    this.gl = gl;
    // 単体コンテキスト (aratanagara.com) では float FBO 拡張を自前で有効化 (vj では有効済みで無害)
    gl.getExtension('EXT_color_buffer_float');
    this.startTime = performance.now()/1000;

    // ── ① シミュレーション: カールノイズで位置を進める (RGBA32F ping-pong) ──
    const simVS = `#version 300 es
precision highp float;
in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;
    const simFS = `#version 300 es
precision highp float;
in vec2 vUv;
layout(location=0) out vec4 fragPos;   // 位置 + 寿命
layout(location=1) out vec4 fragVel;   // 速度 (向きの慣性)
uniform sampler2D uPos;     // 現在位置 + 寿命
uniform sampler2D uVel;     // 前フレームの速度
uniform sampler2D uSeed;    // 初期位置 (再生成先)
uniform float uTime, uDt, uSpeed, uEvolution, uTurb, uRadius, uLife, uOutflow;
uniform float uFlock, uCohesion, uSpeedVar, uSwirl, uSwirlTilt, uInertia;
uniform vec3 uCenter;        // 群れの中心 (パス上を移動する)
uniform float uPathPull, uEmitter;

// --- simplex noise (Ashima Arts / webgl-noise, MIT) ---
vec3 mod289(vec3 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec4 mod289(vec4 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314*r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
vec3 snoiseVec3(vec3 x){
  return vec3(snoise(vec3(x)*0.99 + 19.1),
              snoise(vec3(x.y - 33.4, x.z + 47.2, x.x + 74.2)),
              snoise(vec3(x.z + 74.2, x.x - 124.5, x.y + 99.4)));
}
// カールノイズ: 発散のない流れ場 → 渦を巻きながら群れが崩れない
vec3 curlNoise(vec3 p){
  const float e = 0.1;
  vec3 dx = vec3(e, 0.0, 0.0), dy = vec3(0.0, e, 0.0), dz = vec3(0.0, 0.0, e);
  vec3 p_x0 = snoiseVec3(p - dx), p_x1 = snoiseVec3(p + dx);
  vec3 p_y0 = snoiseVec3(p - dy), p_y1 = snoiseVec3(p + dy);
  vec3 p_z0 = snoiseVec3(p - dz), p_z1 = snoiseVec3(p + dz);
  float x = p_y1.z - p_y0.z - p_z1.y + p_z0.y;
  float y = p_z1.x - p_z0.x - p_x1.z + p_x0.z;
  float z = p_x1.y - p_x0.y - p_y1.x + p_y0.x;
  return normalize(vec3(x, y, z) / (2.0*e));
}
mat3 rotY(float a){ float c=cos(a), s=sin(a); return mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c); }
float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main(){
  vec4 c = texture(uPos, vUv);
  vec3 pos = c.xyz;
  float life = c.a;
  vec3 oldVel = texture(uVel, vUv).xyz;
  // 個体ごとの速度ばらつき (大きい = ばらけて帯が伸びる / 0 = 全員同速 = 群れが揃う)
  float sp = mix(1.0, mix(0.45, 1.0, fract(vUv.x*7.31 + vUv.y*3.17)), uSpeedVar);
  // 群れ感: 細かい渦(個々バラバラ) と 大きな渦(全員が同じ流れ) をブレンド
  vec3 vFine   = curlNoise(uTurb*0.2*pos  + uEvolution*0.1*uTime);
  vec3 vCoarse = curlNoise(uTurb*0.05*pos + uEvolution*0.05*uTime + 11.3);
  vec3 want = normalize(mix(vFine, vCoarse, uFlock) + vec3(1e-6));
  // 以降の半径方向の力は「群れの中心」からの相対位置で見る (中心はパス上を移動する)
  vec3 rel = pos - uCenter;
  float relLen = length(rel) + 1e-5;
  vec3 rdir = rel / relLen;
  want += rdir * uOutflow;                          // 外へ吹き出す成分 (無いと球殻に張り付く)
  // 周回軌道: 傾けられた軸のまわりを旋回する (符号で向きが反転)
  vec3 axis = normalize(vec3(uSwirlTilt, 1.0, uSwirlTilt*0.6));
  want += cross(axis, rel) * uSwirl * 0.45;
  // 凝集: 群れの外へ出た個体をゆるやかに殻へ引き戻す
  float shellR = uRadius * 1.9;
  want -= rdir * (relLen - shellR) * uCohesion * 0.6;
  // 中心の空洞: 硬いクランプではなく内側から押し返す力 (急な折り返しを作らない)
  want += rdir * max(0.0, uRadius - relLen) * 2.5;
  // パス追従: 移動する中心へ引かれる → 群れ全体が ∞ などの軌跡を描く
  want += (-rdir) * uPathPull;
  want = normalize(want + vec3(1e-6));

  // 鳥の群れのように「向きを少しずつ変える」= 慣性つきの旋回。turn が小さいほど滑らか。
  float turn = clamp(mix(1.0, 0.035, uInertia), 0.01, 1.0);
  vec3 vel = (dot(oldVel, oldVel) < 1e-8) ? want : normalize(mix(normalize(oldVel), want, turn) + vec3(1e-6));
  pos += vel * uDt * uSpeed * sp;
  life -= 1.0;
  if(life <= 0.0){
    // 湧き直し: Emitter で「どこから出るか」を選ぶ。既定は空間全体なので湧き口が見えない。
    vec3 sdir = normalize(rotY(uTime*0.25) * texture(uSeed, vUv).xyz + vec3(1e-5));
    float h1 = hash21(vUv*13.7 + floor(uTime*7.0));
    int em = int(uEmitter + 0.5);
    float rr;
    if(em == 1)      rr = uRadius;                  // 中心の球殻 (原作)
    else if(em == 2) rr = uRadius * 3.2;            // 外殻から中へ
    else if(em == 3) rr = uRadius * 0.3 * h1;       // 中心の点から噴き出す
    else             rr = mix(uRadius, uRadius*3.0, h1);   // 空間全体にばらけて湧く
    pos = uCenter + sdir * rr;
    life = uLife;
    vel = want;                                     // 湧き直しでも向きは流れに沿わせる
  }
  fragPos = vec4(pos, life);
  fragVel = vec4(vel, 1.0);
}`;

    // ── ② 描画: 1 粒 = 交差する三角形の刃。表=ブルー / 裏=クローム (aratanagara 準拠) ──
    const drawVS = `#version 300 es
precision highp float;
in vec3 aBlade;    // x: -1..1 (刃の横), y: 0..1 (根元→先端), z: 刃番号
in float aId;      // インスタンス番号
uniform sampler2D uPos, uPrev, uVelTex, uVelPrev;
uniform vec2 uGrid;
uniform mat4 uMVP;
uniform float uScale, uSpike, uTwist, uLife, uKick, uTime, uAim, uShapeRand, uBlades;
uniform float uSpinRate, uSpinVar, uShape, uBend, uBendTurn, uFisheye, uNearCull;
uniform vec3 uCamPos;
out vec3 vN; out vec3 vWorld; out float vAlive; out float vSeedR; out float vSpeed; out float vViewDist;
out float vTipDist;   // 刃の先端からの距離 (0=先端 / 1=根元) — クロームの放射グラデ用

// dir を局所 +z にする正規直交基底 (刃の先端 = +z なので dir が「尖りが向く方向」)
mat3 basisFrom(vec3 dir, float roll){
  vec3 rr = vec3(sin(roll), cos(roll), 0.0);
  vec3 ww = normalize(dir + vec3(1e-5, 0.0, 0.0));
  vec3 uu = normalize(cross(ww, rr));
  vec3 vv = normalize(cross(uu, ww));
  return mat3(uu, vv, ww);
}
float hash11(float n){ return fract(sin(n*127.1)*43758.5453); }

void main(){
  vec2 uv = (vec2(mod(aId, uGrid.x), floor(aId / uGrid.x)) + 0.5) / uGrid;
  vec4 cur = texture(uPos, uv);
  vec3 prev = texture(uPrev, uv).xyz;
  float alive = clamp(cur.a / max(uLife, 1.0), 0.0, 1.0);
  // 生成/消滅で大きさが膨らんで消える (パラボラ)
  float grow = pow(4.0 * alive * (1.0 - alive), 0.7);
  float r = hash11(aId*1.37 + 3.1);
  float sz = uScale * 0.10 * mix(0.55, 1.5, r) * grow;
  // カメラに近すぎる破片は縮めて消す (画面を覆う巨大な板になるのを防ぐ)
  if(uNearCull > 0.001){
    float camD = length(cur.xyz - uCamPos);
    sz *= smoothstep(uNearCull * 0.35, uNearCull, camD);
  }

  // 刃 (三角形) をローカルに組む: 根元は原点をまたいで反対側へ抜ける = 互いに交差する
  float bi = aBlade.z;
  float rb  = hash11(aId*13.1 + bi*5.7);        // 粒×刃ごとの乱数 (形状のばらつき)
  float rb2 = hash11(aId*17.7 + bi*3.3);
  float rb3 = hash11(aId*23.3 + bi*9.1);
  // 形状ランダム: 刃を間引く (= 粒ごとに角の数が変わる) / 長さ・幅・非対称さを散らす
  if(uShapeRand > 0.01 && rb > mix(1.0, 0.42, uShapeRand)){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float lenMul = mix(1.0, mix(0.30, 1.9, rb2), uShapeRand);
  float widMul = mix(1.0, mix(0.35, 2.0, rb3), uShapeRand);
  float skew   = mix(0.0, (rb2 - 0.5) * 1.5, uShapeRand);      // 先端を横へずらす = 非対称な鋭角
  float jit    = mix(0.0, (rb3 - 0.5) * 1.2, uShapeRand);      // 刃の角度を等間隔から崩す
  // 自転: Twist = 個体ごとの位相ばらつき / Spin Rate = 回転の速さ (個体差は Spin Var)
  float spinDir = mix(-1.0, 1.0, step(0.5, hash11(aId*5.7)));
  float spinRate = uSpinRate * mix(1.0, mix(0.2, 2.0, hash11(aId*8.93 + 4.4)), uSpinVar);
  float ang = (bi + jit) * 6.2831853 / max(uBlades, 1.0)
            + uTwist * r * 6.2831853
            + uTime * 0.35 * spinRate * spinDir;
  float ca = cos(ang), sa = sin(ang);
  float spike = uSpike * (0.7 + 0.9*hash11(aId*2.71 + bi)) * (1.0 + uKick) * lenMul;
  // aBlade.y: -0.35 で原点の裏側 / 1.0 で先端。x は根元だけ幅を持ち先端で 0 → 鋭利
  // 刃の形 (プルダウン): 0=三角 1=矢 2=針 3=薄片 4=十字
  int shp = int(uShape + 0.5);
  float wMul = 0.62, sMul = 1.0, baseMul = 1.0;
  if(shp == 1){ wMul = 1.05; sMul = 0.72; baseMul = 0.5; }        // 矢: 幅広で短い
  else if(shp == 2){ wMul = 0.24; sMul = 1.75; baseMul = 0.7; }   // 針: 細長い
  else if(shp == 3){ wMul = 1.35; sMul = 0.45; baseMul = 1.6; }   // 薄片: 平たい破片
  else if(shp == 4){ wMul = 0.42; sMul = 1.15; baseMul = 2.6; }   // 十字: 原点を大きく貫く
  float w = aBlade.x * widMul * (1.0 - max(aBlade.y, 0.0)) * wMul;
  float tip = max(aBlade.y, 0.0);
  float yy = (aBlade.y < 0.0) ? aBlade.y * baseMul : aBlade.y;
  vec3 local = vec3(ca*w - sa*yy*0.25 + skew*tip, sa*w + ca*yy*0.25, yy*spike*sMul);
  // 鋭い先端の位置 (aBlade.y = 1 の点) からの距離 → 先端起点の放射グラデに使う
  vec3 tipLocal = vec3(skew, 0.0, spike*sMul);
  vTipDist = clamp(length(local - tipLocal) / max(spike*sMul*1.35, 1e-3), 0.0, 1.0);
  // 向き: 0=進行方向 / 1=後ろ / 2=外向き / 3=中心向き / 4=カメラ / 5=個体固定ランダム
  vec3 vel = texture(uVelTex, uv).xyz;          // 慣性つきの滑らかな進行方向
  if(dot(vel, vel) < 1e-8) vel = cur.xyz - prev;
  int aim = int(uAim + 0.5);
  vec3 dir;
  if(aim == 1)      dir = -vel;
  else if(aim == 2) dir = cur.xyz;
  else if(aim == 3) dir = -cur.xyz;
  else if(aim == 4){                            // 画面内の進行方向 (視線に垂直 = 刃が画面へ正対して長く見える)
    vec3 camDir = normalize(cur.xyz - uCamPos);
    dir = vel - camDir * dot(vel, camDir);
  }
  else if(aim == 5) dir = vec3(hash11(aId*3.7)-0.5, hash11(aId*7.3+1.0)-0.5, hash11(aId*11.9+2.0)-0.5);
  else              dir = vel;
  mat3 rot = basisFrom(dir, r*6.2831);

  // 進行方向への曲げ: 先端ほど横へ反らせる (円弧)。
  //   Bend Turn = 0 → 個体ごとの一定方向へ湾曲 / 1 → 実際の旋回方向へ反る (旋回時に翼を反らす感じ)
  float bAng = hash11(aId*4.31 + bi*2.7) * 6.2831853;
  vec3 bFixed = rot * vec3(cos(bAng), sin(bAng), 0.0);
  vec3 vPrev = texture(uVelPrev, uv).xyz;
  vec3 turnV = normalize(vel + vec3(1e-6)) - normalize(vPrev + vec3(1e-6));
  vec3 bTurn = (dot(turnV, turnV) > 1e-10) ? normalize(turnV) : bFixed;
  vec3 bendDir = normalize(mix(bFixed, bTurn, uBendTurn) + vec3(1e-6));
  float arc = uBend * (0.35 + 0.65*hash11(aId*9.71)) * tip * tip * spike * 0.55;

  vec3 world = cur.xyz + rot * (local * sz) + bendDir * (arc * sz);

  // 法線: 刃の面法線をワールドへ
  vec3 nLocal = normalize(vec3(-sa, ca, 0.12));
  vN = normalize(rot * nLocal);
  vWorld = world;
  vViewDist = length(world - uCamPos);
  vAlive = alive;
  vSeedR = r;
  vSpeed = clamp(length(vel), 0.0, 4.0);         // 速度 (色モード「速度で色相」用)
  // 広角レンズ: クリップ空間で樽型に歪める (画面端が回り込む魚眼)
  vec4 cp = uMVP * vec4(world, 1.0);
  if(uFisheye > 0.001 && cp.w > 0.0){
    vec2 ndc = cp.xy / cp.w;
    float r2 = dot(ndc, ndc);
    ndc *= 1.0 - uFisheye * 0.22 * r2;
    cp.xy = ndc * cp.w;
  }
  gl_Position = cp;
}`;
    const drawFS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vWorld; in float vAlive; in float vSeedR; in float vSpeed; in float vViewDist; in float vTipDist;
out vec4 o;
uniform float uFog, uAlpha, uDist, uFogNear, uFogFar;
uniform float uHueShift, uSat, uBgLight, uChrome, uColorMode, uBlueLight, uChromeLight;
uniform float uChromeCon, uChromeFloor, uNearFade, uPass, uNearMode;
uniform vec3 uCamPos, uCamRight, uCamUp;   // 反射をカメラ基準で計算 (公転カメラでも aratanagara と同じ見え方)
uniform float uStripeFreq, uStripeScale, uStripeAmt, uStripeW;   // 反射帯: 向き周波数 / 空間周期 / 濃さ / 幅
uniform float uGlintAmt, uGlintSharp, uSpecAmt;                  // グリント量 / 鋭さ / スペキュラ量
// 8x8 Bayer 順序ディザ (Near Mode = ディザ 用)
float bayer8(vec2 c){
  int x = int(mod(c.x, 8.0)), y = int(mod(c.y, 8.0));
  int r = 0;
  for(int i = 2; i >= 0; i--){
    int xb = (x >> i) & 1, yb = (y >> i) & 1;
    r = (r << 2) | ((xb ^ yb) << 1) | yb;
  }
  return (float(r) + 0.5) / 64.0;
}
// 色相回転 (YIQ。vj 本体の hueShift と同じ式)
vec3 hueRot(vec3 c, float h){
  const mat3 toYIQ = mat3(0.299,0.596,0.211,  0.587,-0.274,-0.523,  0.114,-0.322,0.312);
  const mat3 toRGB = mat3(1.0,1.0,1.0,        0.956,-0.272,-1.106,  0.621,-0.647,1.703);
  vec3 yiq = toYIQ * c;
  float a = h * 6.2831853, ca = cos(a), sa = sin(a);
  vec2 iq = yiq.yz;
  yiq.y = ca*iq.x - sa*iq.y;
  yiq.z = sa*iq.x + ca*iq.y;
  return toRGB * yiq;
}
void main(){
  // aratanagara と同じ構成でライティングを組む。相違点は 2 つだけ:
  //   ① 裏面は法線を反転して視線側に向ける (これをしないと反射の位相が破綻する)
  //   ② aratanagara は固定カメラなのでワールド x/y/z がそのまま画面基準だが、
  //      shredder は公転カメラなので viewDir と法線をカメラ基底 (right/up/forward) に射影して使う
  vec3 nn = normalize(vN);
  if(!gl_FrontFacing) nn = -nn;
  vec3 l1 = normalize(vec3(-0.42, 0.72, 0.56));
  vec3 l2 = normalize(vec3(0.64, -0.20, 0.62));
  float d1 = max(0.0, dot(nn, l1));
  float d2 = max(0.0, dot(nn, l2));
  vec3 viewDir = normalize(uCamPos - vWorld);
  float spec1 = pow(max(0.0, dot(reflect(-l1, nn), viewDir)), 30.0);
  float spec2 = pow(max(0.0, dot(reflect(-l2, nn), viewDir)), 46.0);
  // カメラ基底での法線成分 (= aratanagara の nn.x / nn.y / nn.z に対応)
  vec3 nv = vec3(dot(nn, uCamRight), dot(nn, uCamUp), dot(nn, viewDir));
  vec2 pv = vec2(dot(vWorld, uCamRight), dot(vWorld, uCamUp));   // 画面平面でのワールド位置
  float rim = pow(max(0.0, 1.0 - abs(nv.z)), 1.45);
  float band = 0.5 + 0.5*sin(vWorld.x*5.2 - vWorld.y*2.7 + vWorld.z*6.4 + nn.x*3.0);
  float light = clamp(0.11 + d1*0.50 + d2*0.22 + rim*0.16 + band*0.08, 0.04, 1.0);

  // 表面: 既定は aratanagara と同じディープブルー #3F00FF 系。色相/彩度はパラメータで回す
  int cm = int(uColorMode + 0.5);
  float hueX = uHueShift + ((cm == 3) ? vSpeed * 0.12 : 0.0);      // 速度で色相を回す
  vec3 greenBase = hueRot(vec3(0.020, 0.380, 0.080), hueX);
  if(cm == 1) greenBase = vec3(0.62, 0.66, 0.72);
  greenBase = mix(vec3(dot(greenBase, vec3(0.299,0.587,0.114))), greenBase, uSat);
  greenBase = clamp(greenBase, 0.0, 1.0);
  vec3 green = greenBase * (0.32 + 0.78*light);
  green = mix(vec3(0.003,0.030,0.008), green, smoothstep(0.04, 0.92, light));
  green *= 0.88 + 0.16*band;
  green += vec3(0.05,0.55,0.12) * pow(max(0.0, d1*0.64 + rim*0.58 + band*0.10), 2.5) * 0.18;
  green += vec3(0.15,0.85,0.20) * (spec1*0.05 + spec2*0.03 + pow(rim,2.2)*0.05);

  // 裏面: クローム
  // 裏面クロームは aratanagara のシェイプ裏面と同じ式 (mode/aratanagara.js より移植)。
  //   metal(面の向き) で映り込みの位相を作り、stripe(帯) と glint(芯) を重ねる。
  //   Chrome Con = 階調の硬さ / Chrome Floor = 黒つぶれの持ち上げ。
  float metal = clamp(0.38 + abs(nv.z)*0.36 + nv.x*0.18 - nv.y*0.10 + band*0.28, 0.0, 1.0);
  // 反射帯: aratanagara の (metal*34 + 空間位相) 構成をパラメータ化。
  //   既定値 (Freq34 / Scale1 / Amt0.52 / W0.5 / Glint0.62,40 / Spec1) = 現在の見た目そのまま。
  //   空間周期 31,17 は aratanagara (9,5) の約3.5倍 = 小さな刃の中に数本の帯が入るスケール。
  float mirror = sin(metal*uStripeFreq + light*5.2 + (pv.x*31.0 - pv.y*17.0)*uStripeScale) * 0.5 + 0.5;
  float sw = mix(0.02, 0.28, clamp(uStripeW, 0.0, 1.0));
  float stripe = smoothstep(0.72 - sw, min(0.72 + sw, 0.98), mirror);
  float glint  = pow(max(0.0, mirror), max(uGlintSharp, 1.0));
  float rimChrome = pow(rim, 2.0) * (0.40 + 0.60*d2);
  float cc = clamp(uChromeCon, 0.0, 2.0);
  float ccL = min(cc, 1.0);
  vec3 chromeDark = mix(vec3(0.26,0.28,0.32), vec3(0.030,0.034,0.046), ccL);
  vec3 chrome = mix(chromeDark, vec3(0.58,0.66,0.78), pow(light, mix(0.9, 1.5, ccL)));
  chrome = mix(chrome, vec3(0.165,0.180,0.215), pow(1.0-mirror, 3.0) * 0.12);
  chrome = mix(chrome, vec3(0.82,0.91,1.00), stripe * uStripeAmt);
  chrome += vec3(0.95,0.98,1.00) * (spec1*0.50 + spec2*0.42 + rimChrome*0.24) * uSpecAmt;
  chrome = mix(chrome, vec3(1.00,1.00,0.96), glint * uGlintAmt);
  chrome = clamp(uChromeFloor + (1.0 - uChromeFloor) * chrome, 0.0, 1.0);   // 黒つぶれの持ち上げ

  float chromeAmt = (cm == 2) ? 0.0 : ((cm == 1) ? 1.0 : uChrome);
  green   = clamp(green   * uBlueLight,   0.0, 1.0);
  chrome  = clamp(chrome * uChromeLight, 0.0, 1.0);
  vec3 col = gl_FrontFacing ? green : mix(green, chrome, chromeAmt);
  // 空気遠近: 奥ほど背景色へ。背景は明るいグレー(aratanagara) ↔ 暗いチャコールを Bg で選ぶ
  vec3 bg = mix(vec3(0.055, 0.058, 0.070), vec3(0.690, 0.733, 0.800), uBgLight);
  // 距離はカメラからの実距離で測る (公転カメラだとワールド z は奥行きにならない)。
  //   Fog Near/Far はカメラ距離に対する比率なので、寄り引きしても霞み方が保たれる。
  float depth = smoothstep(uDist*uFogNear, uDist*uFogFar, vViewDist);
  float k = clamp(depth * uFog, 0.0, 1.0);
  float luma = dot(col, vec3(0.299,0.587,0.114));
  col = mix(col, mix(vec3(luma), bg, 0.5), k*0.62);
  col = mix(col, bg, k*0.62);
  // カメラ至近は実アルファで半透明にする (ディザの点々を出さない)。
  //   不透明パス = 至近以外 / 半透明パス = 至近のみ。深度書き込みを切ってブレンドするので
  //   手前の面がなめらかに薄くなり、奥の破片がそのまま見える。
  float nearA = 1.0;
  if(uNearFade > 0.001) nearA = smoothstep(uNearFade * 0.35, uNearFade * 1.5, vViewDist);
  int nm = int(uNearMode + 0.5);
  if(nm == 0){                                        // 透明度: 2 パスの実アルファ (点々にならない)
    if(uPass < 0.5){ if(nearA < 0.999) discard; }               // 不透明パス = 至近以外
    else { if(nearA >= 0.999 || nearA <= 0.002) discard; }      // 半透明パス = 至近のみ
  } else if(nm == 1){                                 // ディザ: 順序に依存しない網点の透過
    if(nearA < bayer8(gl_FragCoord.xy)) discard;
  } else if(nm == 2){                                 // 背景へ溶かす
    col = mix(col, bg, 1.0 - nearA);
  }
  float outA = (nm == 0 || nm == 1) ? nearA : 1.0;
  o = vec4(clamp(col, 0.0, 1.0), uAlpha * outA);
}`;

    const sh = (type, src)=>{ const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
      if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('[shredder]', gl.getShaderInfoLog(s));
      return s; };
    const link = (vsSrc, fsSrc)=>{ const p=gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
      gl.linkProgram(p);
      if(!gl.getProgramParameter(p, gl.LINK_STATUS)) console.warn('[shredder] link', gl.getProgramInfoLog(p));
      return p; };
    this.simProg = link(simVS, simFS);
    this.drawProg = link(drawVS, drawFS);

    // フルスクリーン三角形 (シミュレーション用)
    this.simVAO = gl.createVertexArray();
    this.simVBO = gl.createBuffer();
    gl.bindVertexArray(this.simVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.simVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(this.simProg, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.buildSim();
    this.buildBlades();
    this._warm();
    this.initialized = true;
  },

  // ===== シミュレーション用テクスチャ (grid×grid) =====
  buildSim(){
    const gl = this.gl;
    const N = Math.max(8, Math.min(256, Math.round(this.P.grid)));
    if(this.sim && this.sim.w === N) return;
    if(this.sim){ this.sim.tex.forEach(t=>gl.deleteTexture(t)); (this.sim.vel||[]).forEach(t=>gl.deleteTexture(t)); this.sim.fbo.forEach(f=>gl.deleteFramebuffer(f)); }
    if(this.seedTex) gl.deleteTexture(this.seedTex);

    // 初期位置: 球殻上のランダム点 (原作と同じ)
    const rnd = this._rng(this.P.seed);
    const data = new Float32Array(N*N*4);
    for(let i=0;i<N*N;i++){
      const phi = rnd()*Math.PI*2, ct = rnd()*2-1, th = Math.acos(ct);
      const r = 0.85 + 0.15*rnd();      // clamp 半径より内側から湧く → 殻へ押し出されて流れ出す
      data[i*4]   = r*Math.sin(th)*Math.cos(phi);
      data[i*4+1] = r*Math.sin(th)*Math.sin(phi);
      data[i*4+2] = r*Math.cos(th);
      data[i*4+3] = rnd()*this.P.life;
    }
    const mkTex = (src)=>{
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, N, N, 0, gl.RGBA, gl.FLOAT, src || null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.seedTex = mkTex(data);
    const tex = [mkTex(data), mkTex(data)];
    const vel = [mkTex(null), mkTex(null)];      // 速度 (慣性のある滑らかな旋回のため保持)
    const fbo = tex.map((t,i)=>{
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, vel[i], 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      return f;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.sim = {w:N, h:N, tex, vel, fbo, cur:0};
    this.instances = N*N;
    this.buildInstanceIds();
  },

  // ===== 刃 (三角形) のローカル頂点 =====
  //   1 枚の刃 = 3 頂点。y: -0.35(原点の裏) / 1.0(先端)。x: 根元だけ幅あり。
  //   刃を uTwist で回すので、複数枚が原点を貫いて互いに交差する。
  buildBlades(){
    const gl = this.gl;
    const nb = Math.max(1, Math.min(6, Math.round(this.P.blades)));
    const v = [];
    for(let b=0;b<nb;b++){
      v.push(-1.0, -0.35, b,   1.0, -0.35, b,   0.0, 1.0, b);
    }
    this.bladeVerts = v.length/3;
    if(!this.bladeVBO) this.bladeVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bladeVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    this._bindDrawVAO();
  },
  buildInstanceIds(){
    const gl = this.gl;
    const ids = new Float32Array(this.instances);
    for(let i=0;i<this.instances;i++) ids[i] = i;
    if(!this.idVBO) this.idVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.idVBO);
    gl.bufferData(gl.ARRAY_BUFFER, ids, gl.STATIC_DRAW);
    this._bindDrawVAO();
  },
  _bindDrawVAO(){
    const gl = this.gl;
    if(!this.bladeVBO || !this.idVBO) return;
    if(!this.drawVAO) this.drawVAO = gl.createVertexArray();
    gl.bindVertexArray(this.drawVAO);
    const aB = gl.getAttribLocation(this.drawProg, 'aBlade');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bladeVBO);
    gl.enableVertexAttribArray(aB);
    gl.vertexAttribPointer(aB, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(aB, 0);
    const aI = gl.getAttribLocation(this.drawProg, 'aId');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.idVBO);
    gl.enableVertexAttribArray(aI);
    gl.vertexAttribPointer(aI, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(aI, 1);
    gl.bindVertexArray(null);
  },
  // 粒数 / 刃数 / seed を変えたときの作り直し (UI から呼ぶ)
  rebuild(){
    if(!this.initialized) return;
    const n = this.sim ? this.sim.w : 0;
    this.buildSim();
    this.buildBlades();
    if(this.sim && this.sim.w !== n) this._warm();
  },

  _ensureDepth(w,h){
    const gl = this.gl;
    if(this.depthRBO && this.depthW===w && this.depthH===h) return;
    if(this.depthRBO) gl.deleteRenderbuffer(this.depthRBO);
    this.depthRBO = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRBO);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    this.depthW = w; this.depthH = h;
  },

  // 群れの中心が描く軌跡。円運動だけでなく ∞ / リサージュ / 結び目を選べる。
  //   0=なし(原点) 1=円 2=無限(∞) 3=リサージュ 4=トーラス結び目 5=8の字(縦)
  pathCenter(clock){
    const P = this.P;
    const k = Math.round(P.path || 0);
    if(k === 0) return [0, 0, 0];
    const t = clock * (P.pathRate || 0) * 0.6;
    const R = P.pathSize || 0;
    switch(k){
      case 1: return [Math.cos(t)*R, 0, Math.sin(t)*R];                                  // 円
      case 2: return [Math.cos(t)*R, 0, Math.sin(t)*Math.cos(t)*R];                      // ∞ (横向き)
      case 3: return [Math.sin(t*3.0)*R, Math.sin(t*2.0)*R*0.6, Math.cos(t*4.0)*R*0.8];  // リサージュ
      case 4: {                                                                           // トーラス結び目 (p=2,q=3)
        const r = 0.45*R*(2.0 + Math.cos(3.0*t));
        return [r*Math.cos(2.0*t), 0.45*R*Math.sin(3.0*t), r*Math.sin(2.0*t)];
      }
      default: return [Math.cos(t)*R, Math.sin(t)*Math.cos(t)*R, 0];                      // 8の字(縦)
    }
  },
  // シミュレーションを 1 ステップ進めて、書き込んだ側の index を返す
  _simStep(clock, dt){
    const gl = this.gl, P = this.P;
    const prevIdx = this.sim.cur, nextIdx = 1 - this.sim.cur;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sim.fbo[nextIdx]);
    gl.viewport(0, 0, this.sim.w, this.sim.h);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.useProgram(this.simProg);
    gl.bindVertexArray(this.simVAO);
    const uS = (n)=>gl.getUniformLocation(this.simProg, n);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sim.tex[prevIdx]);
    gl.uniform1i(uS('uPos'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.seedTex);
    gl.uniform1i(uS('uSeed'), 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.sim.vel[prevIdx]);
    gl.uniform1i(uS('uVel'), 2);
    gl.uniform1f(uS('uTime'), clock);
    gl.uniform1f(uS('uDt'), dt);
    gl.uniform1f(uS('uSpeed'), P.speed * 1.6);
    gl.uniform1f(uS('uEvolution'), P.evolution);
    gl.uniform1f(uS('uTurb'), P.turbulence);
    gl.uniform1f(uS('uRadius'), P.radius);
    gl.uniform1f(uS('uLife'), P.life);
    gl.uniform1f(uS('uOutflow'), P.outflow);
    gl.uniform1f(uS('uFlock'), P.flock);
    gl.uniform1f(uS('uCohesion'), P.cohesion);
    gl.uniform1f(uS('uSpeedVar'), P.speedVar);
    gl.uniform1f(uS('uSwirl'), P.swirl);
    gl.uniform1f(uS('uSwirlTilt'), P.swirlTilt);
    gl.uniform1f(uS('uInertia'), P.inertia);
    { const c = this.pathCenter(clock);
      gl.uniform3f(uS('uCenter'), c[0], c[1], c[2]);
      this._center = c; }
    gl.uniform1f(uS('uPathPull'), P.pathPull);
    gl.uniform1f(uS('uEmitter'), P.emitter);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.sim.cur = nextIdx;
    return nextIdx;
  },
  // 湧き出し直後は球殻のままなので、生成時に数秒ぶん先送りして最初から群れの形にする
  _warm(steps){
    if(!this.sim) return;
    const n = steps || 360;
    for(let i=0;i<n;i++) this._simStep(i/60, 1/60);
    this.lastClock = 0;
  },

  // 背景色 (フラグメント側の空気遠近と同じ式)。bgLight: 0=チャコール / 1=明るいグレー
  bgColor(){
    const k = Math.max(0, Math.min(1, this.P.bgLight));
    const a = [0.055, 0.058, 0.070], b = [0.690, 0.733, 0.800];
    return [a[0]+(b[0]-a[0])*k, a[1]+(b[1]-a[1])*k, a[2]+(b[2]-a[2])*k];
  },

  update(){},

  render(opts){
    const gl = this.gl;
    if(!this.initialized || !this.sim) return;
    const P = this.P;
    const w = opts.w, h = opts.h;
    const clock = (opts.clock != null) ? opts.clock : (performance.now()/1000 - this.startTime);
    let dt = clock - this.lastClock;
    if(!(dt > 0) || dt > 0.2) dt = 1/60;
    this.lastClock = clock;

    // 拍キック (beat < 0 = drone)
    const beat = (opts.beat != null) ? opts.beat : -1.0;
    if(beat >= 0.0){
      const ph = beat - Math.floor(beat);
      this.beatPulse = Math.pow(1.0 - ph, 3.0) * P.beatKick;
    } else {
      this.beatPulse *= 0.92;
    }

    // ── ① シミュレーションを 1 ステップ進める (前フレームは向き算出に使う) ──
    const prevIdx = this.sim.cur;
    const nextIdx = this._simStep(clock, Math.min(dt, 1/20) * (1.0 + this.beatPulse*1.5));

    // ── ② 破片を描画 ──
    // fbo=null (aratanagara.com の default framebuffer) には RBO を付けられない。
    // その場合はコンテキスト作成時の depth:true の深度バッファをそのまま使う。
    const useRBO = !!opts.fbo;
    if(useRBO){
      this._ensureDepth(w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, opts.fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRBO);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.viewport(0, 0, w, h);
    const opaque = (opts.opaque !== false);
    const bg = this.bgColor();
    gl.clearColor(opaque ? bg[0] : 0, opaque ? bg[1] : 0, opaque ? bg[2] : 0, opaque ? 1 : 0);
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);            // 両面 = 表ブルー / 裏クローム
    gl.disable(gl.BLEND);

    // カメラ経路 (プルダウン): 0=周回 1=螺旋 2=静止 3=ドリフト
    const path = Math.round(P.camPath || 0);
    if(path !== 2) this.cam.az += dt * P.autorot * 0.6 * (path === 3 ? (0.6 + 0.8*Math.sin(clock*0.11)) : 1.0);
    let el = (P.camEl == null ? 0.16 : P.camEl) + Math.sin(clock * P.orbitTiltRate) * P.orbitTilt;
    let dist = P.dist * (1.0 + P.orbitEllip * Math.cos(this.cam.az * 2.0));
    if(path === 1){                       // 螺旋: 仰角を大きくスイープしつつ距離が息をする
      el += 0.75 * Math.sin(clock * P.orbitTiltRate * 0.35);
      dist *= 1.0 + 0.22 * Math.sin(clock * P.orbitTiltRate * 0.5 + 1.3);
    } else if(path === 3){                // ドリフト: ゆっくり彷徨う
      el  += 0.25 * (Math.sin(clock*0.17) + 0.6*Math.sin(clock*0.07 + 2.1));
      dist *= 1.0 + 0.12 * Math.sin(clock*0.09 + 0.5);
    }
    el = Math.max(-1.35, Math.min(1.35, el));
    // 注視点は群れの中心 (パス上を移動)。Cam Follow で追従量を決める
    const c = this._center || [0,0,0], f = (P.camFollow == null ? 1 : P.camFollow);
    const tgt = [c[0]*f, c[1]*f, c[2]*f];
    const eye = [tgt[0] + Math.sin(this.cam.az)*Math.cos(el)*dist,
                 tgt[1] + Math.sin(el)*dist,
                 tgt[2] + Math.cos(this.cam.az)*Math.cos(el)*dist];
    const view = this.m4.lookAt(eye, tgt, [0,1,0]);
    const proj = this.m4.persp(P.fov*Math.PI/180, w/Math.max(1,h), 0.05, dist*6);
    const mvp = this.m4.mul(proj, view);

    gl.useProgram(this.drawProg);
    gl.bindVertexArray(this.drawVAO);
    const uD = (n)=>gl.getUniformLocation(this.drawProg, n);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sim.tex[nextIdx]);
    gl.uniform1i(uD('uPos'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.sim.tex[prevIdx]);
    gl.uniform1i(uD('uPrev'), 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.sim.vel[nextIdx]);
    gl.uniform1i(uD('uVelTex'), 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.sim.vel[prevIdx]);
    gl.uniform1i(uD('uVelPrev'), 3);
    gl.uniform2f(uD('uGrid'), this.sim.w, this.sim.h);
    gl.uniformMatrix4fv(uD('uMVP'), false, mvp);
    gl.uniform1f(uD('uScale'), P.scale);
    gl.uniform1f(uD('uSpike'), P.spike);
    gl.uniform1f(uD('uTwist'), P.twist);
    gl.uniform1f(uD('uLife'), P.life);
    gl.uniform1f(uD('uKick'), this.beatPulse);
    gl.uniform1f(uD('uTime'), clock);
    gl.uniform1f(uD('uFog'), P.fog);
    gl.uniform1f(uD('uFogNear'), P.fogNear);
    gl.uniform1f(uD('uFogFar'), P.fogFar);
    gl.uniform1f(uD('uHueShift'), P.hue);
    gl.uniform1f(uD('uSat'), P.sat);
    gl.uniform1f(uD('uBgLight'), P.bgLight);
    gl.uniform1f(uD('uChrome'), P.chrome);
    gl.uniform1f(uD('uColorMode'), P.colorMode);
    gl.uniform1f(uD('uBlueLight'), P.blueLight);
    gl.uniform1f(uD('uChromeLight'), P.chromeLight);
    gl.uniform1f(uD('uChromeCon'), P.chromeCon);
    gl.uniform1f(uD('uChromeFloor'), P.chromeFloor);
    gl.uniform1f(uD('uStripeFreq'), P.stripeFreq);
    gl.uniform1f(uD('uStripeScale'), P.stripeScale);
    gl.uniform1f(uD('uStripeAmt'), P.stripeAmt);
    gl.uniform1f(uD('uStripeW'), P.stripeW);
    gl.uniform1f(uD('uGlintAmt'), P.glintAmt);
    gl.uniform1f(uD('uGlintSharp'), P.glintSharp);
    gl.uniform1f(uD('uSpecAmt'), P.specAmt);
    gl.uniform1f(uD('uNearFade'), P.nearFade);
    gl.uniform1f(uD('uNearMode'), P.nearMode);
    gl.uniform1f(uD('uNearCull'), P.nearCull);
    gl.uniform1f(uD('uShape'), P.shape);
    gl.uniform1f(uD('uDist'), dist);
    gl.uniform1f(uD('uAlpha'), 1.0);
    gl.uniform1f(uD('uAim'), P.aim);
    gl.uniform3f(uD('uCamRight'), view[0], view[4], view[8]);
    gl.uniform3f(uD('uCamUp'),    view[1], view[5], view[9]);
    gl.uniform1f(uD('uShapeRand'), P.shapeRand);
    gl.uniform1f(uD('uSpinRate'), P.spinRate);
    gl.uniform1f(uD('uSpinVar'), P.spinVar);
    gl.uniform1f(uD('uBend'), P.bend);
    gl.uniform1f(uD('uBendTurn'), P.bendTurn);
    gl.uniform1f(uD('uFisheye'), P.fisheye);
    gl.uniform1f(uD('uBlades'), Math.max(1, Math.round(P.blades)));
    gl.uniform3f(uD('uCamPos'), eye[0], eye[1], eye[2]);
    // ① 不透明パス
    gl.uniform1f(uD('uPass'), 0.0);
    gl.disable(gl.BLEND); gl.depthMask(true);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, this.bladeVerts, this.instances);
    // ② 至近の半透明パス (深度書き込みなし + アルファブレンド = 点々にならない透過)
    if(P.nearFade > 0.001 && Math.round(P.nearMode || 0) === 0){
      gl.uniform1f(uD('uPass'), 1.0);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.bladeVerts, this.instances);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);

    if(useRBO) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
    gl.disable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  },
};

// PDefaults はスクリプト読込時に確定させる (init より先に state 復元が走るため)
Shredder.PDefaults = JSON.parse(JSON.stringify(Shredder.P));

// aratanagara.com など単体ページから参照できるように明示エクスポート (const は window に載らない)
if (typeof window !== 'undefined') window.Shredder = Shredder;
