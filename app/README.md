# 打包留证 · Android 壳（Capacitor）

把仓库根目录的网页包成原生 App。**网页代码只有一份**（仓库根目录），
`sync-www.js` 在打包前把它拷进 `www/`，不存在两份代码各改各的问题。

## 为什么要原生壳

| | 网页版 | APK |
|---|---|---|
| 语音播报 | 浏览器 `speechSynthesis`，麦克风开启时常被系统压掉 | **系统原生 TTS**，不受影响 |
| 摄像头权限 | 每次可能重新询问 | 安装时授权一次 |
| 屏幕常亮 | 靠 WakeLock API，不一定生效 | `FLAG_KEEP_SCREEN_ON`，必然生效 |
| 离线 | 靠 Service Worker | 资源直接打进包 |
| 地址栏 | 有（除非加到主屏幕） | 无 |

网页里通过 `Capacitor.isNativePlatform()` 判断运行环境，
在 APK 里自动改用 `TextToSpeech` 原生插件，网页版逻辑不变。

## 构建

```bash
# 一次性环境（都不需要 sudo）
#   JDK 21  → ~/jdk/jdk-21*        （Capacitor 8 要求 Java 21）
#   Android SDK → ~/Android/Sdk    （platform-35/36 + build-tools）

cd app
npm install
npm run apk            # = sync-www + cap sync + gradle assembleRelease
# 产物：app/android/app/build/outputs/apk/release/app-release.apk
```

改完网页只要重跑 `npm run apk`。

## 签名

`packingproof.keystore`（**不进 git**，必须自己另外备份）。
弄丢了就无法覆盖升级，只能换包名重装、老数据全没。

密钥信息写在 `android/keystore.properties`（同样不进 git）：

```
storeFile=<绝对路径>/packingproof.keystore
storePassword=packingproof
keyAlias=packingproof
keyPassword=packingproof
```

## 已做的原生改动

- `AndroidManifest.xml`：CAMERA / RECORD_AUDIO / MODIFY_AUDIO_SETTINGS / WAKE_LOCK，锁竖屏
- `MainActivity.java`：`FLAG_KEEP_SCREEN_ON`、关闭 `mediaPlaybackRequiresUserGesture`、启动时预申请相机与麦克风权限
- 图标与启动画面：由仓库根目录的 `icon.svg` 渲染生成，自适应图标背景 `#0F1115`
- APK 内不注册 Service Worker（原生壳本来就离线，留着反而会缓存旧版）
