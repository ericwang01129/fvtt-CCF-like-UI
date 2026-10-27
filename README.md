# CCF-like UI (v11)

把 Foundry VTT 玩家端介面簡化成接近 **CCF（Character Card Fantasy／自訂卡牌跑團平台）** 的版面，並額外提供手機模式、場景底圖與 CCF 房間匯入功能。

- **模組 ID**：`ccf-ui-v11`
- **版本**：1.0.0
- **相容性**：Foundry VTT v11（最低 11，已驗證 11.315，最高 12）
- **作者**：ericwang01129
- **語言**：English、正體中文
- **無需 socket**：模組不開自己的 socket；側邊欄分頁設定為 world 範圍（由 Foundry 核心同步），其餘為 client 範圍

---

## 功能總覽

模組由五個彼此獨立的腳本組成，各自註冊自己的 hook，不互相 import：

| 腳本 | 功能 |
| --- | --- |
| `ccf-ui.mjs` | 核心：簡化側邊欄、隱藏場景控制列、鎖定畫布 |
| `ccf-mobile.mjs` | 手機模式：上畫布／下聊天版面、輸入框行為、彈窗抑制 |
| `ccf-backdrop.mjs` | 每個場景可設定模糊底圖，填滿背景顏色區域 |
| `ccf-import.mjs` | 將 CCF 格式房間（`.zip`）匯入成 Foundry 場景 |
| `ccf-chatlog-export.mjs` | 將聊天紀錄匯出成 ccfolia 格式的 HTML log（依聊天頻道分檔） |

### 1. 類 CCF 介面（核心）

啟用後對玩家端：

- 側邊欄分頁可**個別設定顯示／隱藏**（預設顯示 **聊天 / 角色 / 設定**，其餘隱藏）
- 完全隱藏左側場景控制工具列（scene controls）
- 強制鎖定畫布為 **Token → 選擇** 模式
- 若安裝了 **Simple Message Window** 模組，強制其 toggle 永遠為開啟（任何想關閉它的動作都會被即時扳回）

預設只對玩家套用；GM 端不受影響，除非另外開啟「GM 也套用」。

#### 側邊欄分頁顯示控制

聊天、戰鬥、場景、角色、物品、日誌、擲骰表、牌組、播放清單、合輯包等分頁，各有一個獨立的「顯示側邊欄分頁」開關。這些設定為 **world 範圍** —— 由 GM 統一設定一次，所有玩家套用相同結果，變更會即時同步至所有連線中的玩家。**設定分頁**一律保留、無對應開關，以確保隨時能回到設定畫面。

### 2. 手機模式

針對窄螢幕／觸控裝置的版面：

- 上半螢幕顯示整張畫布，鎖定中心、依寬度縮放（使用者平移／縮放會被自動拉回）
- 下半螢幕為聊天視窗，採 1.5 行高的輸入框
- 聊天輸入框：**Enter 換行、Shift/Ctrl/Cmd + Enter 送出**，並在右側加上送出按鈕
- 右下角疊上 **Stylish Action HUD**，可調整縮放與橫向壓縮比例
- 抑制 Foundry 原生的「螢幕太小」警告
- 登入後 6 秒內自動關閉非使用者觸發的浮動視窗（changelog、導覽、模組通知），角色卡與一般對話框不受影響
- **Auto** 模式會依視窗寬度與觸控偵測自動切換（`max-width: 900px`，或觸控裝置 `max-width: 1100px`）

### 3. 場景底圖（Backdrop）

每個場景可在 **場景設定** 對話框指定一張底圖：

1. 開啟場景設定，於「背景圖片」欄位下方找到 **場景底圖** 欄位
2. 用檔案選擇器挑一張圖，或直接貼上路徑
3. 該圖會以輕微模糊渲染於場景背景圖之下，填滿原本由「Background Color」填補的留白／黑邊區域
4. 留空即停用該場景的底圖

設定了底圖的場景，會一併隱藏 Foundry 原生繪製的場景外框線 —— 即 `scene.padding` 不為 0 時環繞畫布的粗框、以及場景沒有背景圖時環繞場景範圍的淡框；兩者疊在底圖上會變成多餘的浮動框線。未設定底圖的場景不受影響，維持 Foundry 預設行為。

底圖資料存於場景 flag `flags.ccf-ui-v11.backdrop`，不影響 token、繪圖等其他圖層。

### 4. 匯入 CCF 房間

GM 可在 **場景目錄** 上方看到「匯入 CCF 房間」按鈕，選擇 CCF 匯出的 `.zip` 即可轉成 Foundry 場景。

對應關係：

| CCF | Foundry |
| --- | --- |
| `foregroundUrl`（場地前景） | 場景中央的圖塊（z 最底） |
| `backgroundUrl`（背景） | 場景底圖（交由底圖功能渲染） |
| `markers` + `items` | 每個實體各一個圖塊 |
| 場地網格 | 方形、視覺隱藏（alpha 0），每格 100 px |
| Token 視野 | 關閉 |
| 全域照明 | 開啟 |

匯入細節：

- 內建極簡 ZIP 解析器，使用瀏覽器原生 `DecompressionStream`（v11 的 Electron／Chromium ≥ 113），無需 JSZip
- 場景尺寸取「場地 + 所有 marker／item」的外框，避免實體落在場地外時被 Foundry 的 padding 上限裁切
- 圖片資產上傳至 `worlds/<world>/ccf-rooms/<importId>/`

### 5. 匯出聊天紀錄（ccfolia 格式）

GM 可在 **設定 → 設定模組 → CCF-like UI (v11)** 找到「匯出聊天紀錄…」按鈕。按下後會先顯示將產生的檔案清單，確認即開始下載。

輸出格式完全對齊 ccfolia 的 log 匯出：每則訊息一個 `<p style="color:#xxxxxx;">`，內含三個 `<span>`（`[頻道]`、發言者、內容），無 CSS class、無時間戳，換行以 `<br>` 表示。

| 項目 | 對應 |
| --- | --- |
| 頻道標記 `[…]` | **Multiple Chat Tabs** 的分頁名稱 |
| 發言者 | `message.alias`（角色名 → 演員名 → 使用者名） |
| 行內顏色 | 該則訊息作者的 **Foundry 使用者顏色**（無值時 `#888888`） |
| 內容 | 訊息 HTML 轉純文字；擲骰訊息改以 `骰面說明 (公式) ＞ 結果` 呈現 |

匯出細節：

- 匯出 `game.messages` **全部**訊息（含密語與 blind roll），依時間排序；僅限 GM。
- 頻道分別讀自 **Multiple Chat Tabs**（`multiple-chat-tabs`）：訊息的 `flags["multiple-chat-tabs"].sourceTab` 旗標，以及 world 設定 `multiple-chat-tabs.tabs`。該模組的過濾規則（密語分頁完全比對、`force` 的 `move`／`duplicate`、無旗標時退回第一個分頁、`showAllMessages`）皆已忠實重現。
- 產生 `<世界名>[all].html`（所有訊息，逐行標註頻道）加上每個頻道各一個檔，打包成 `<世界名>-chatlog.zip` 一次下載。ZIP 為自製的 store-only 寫入器（`ccf-import.mjs` 的反向操作），檔名以 UTF-8 旗標寫入，中文分頁名不會亂碼。
- 採**軟相依**：未安裝或停用 Multiple Chat Tabs 時，改為直接下載單一 `<世界名>[all].html`，所有行標記為 `[main]`。

---

## 設定項目

於 **設定 → 設定模組設定** 調整。

| 設定 | 範圍 | 預設 | 說明 |
| --- | --- | --- | --- |
| 啟用類 CCF 介面 | client | 開 | 開關核心簡化介面 |
| GM 也套用 | client | 關 | 讓 GM 端也套用簡化介面（方便預覽玩家所見） |
| 顯示側邊欄分頁：聊天 | world | 開 | 是否在類 CCF 介面顯示聊天分頁 |
| 顯示側邊欄分頁：戰鬥 | world | 關 | 是否顯示戰鬥分頁 |
| 顯示側邊欄分頁：場景 | world | 關 | 是否顯示場景分頁 |
| 顯示側邊欄分頁：角色 | world | 開 | 是否顯示角色分頁 |
| 顯示側邊欄分頁：物品 | world | 關 | 是否顯示物品分頁 |
| 顯示側邊欄分頁：日誌 | world | 關 | 是否顯示日誌分頁 |
| 顯示側邊欄分頁：擲骰表 | world | 關 | 是否顯示擲骰表分頁 |
| 顯示側邊欄分頁：牌組 | world | 關 | 是否顯示牌組分頁 |
| 顯示側邊欄分頁：播放清單 | world | 關 | 是否顯示播放清單分頁 |
| 顯示側邊欄分頁：合輯包 | world | 關 | 是否顯示合輯包分頁 |
| 手機模式 | client | 自動偵測 | 自動偵測 / 強制開啟 / 強制關閉 |
| 手機模式 SAH 縮放 | client | 0.55 | Stylish Action HUD 動作列表縮放（0.2 ~ 1.0） |
| 手機模式 SAH 橫向壓縮 | client | 0.65 | SAH 動作列表橫向壓縮（0.3 ~ 1.0，越小越窄） |
| 手機模式抑制登入彈窗 | client | 開 | 登入後 6 秒內自動關閉自動浮出的視窗 |

> 側邊欄分頁開關為 **world 範圍**（GM 統一控制）；其餘為 **client 範圍**（每位使用者各自設定）。**設定分頁**永遠保留，無對應開關。

---

## 安裝

### 方法 A：以資訊清單網址安裝（推薦）

在 Foundry 的 **設定 → 附加模組 → 安裝模組** 視窗，將以下資訊清單網址貼到最下方的 **Manifest URL** 欄位後按安裝：

```
https://raw.githubusercontent.com/ericwang01129/fvtt-CCF-like-UI/main/module.json
```

### 方法 B：手動安裝

1. 將 `ccf-ui-v11` 資料夾放入 Foundry 的 `Data/modules/` 目錄
2. 啟動 Foundry，在世界中啟用「CCF-like UI (v11)」模組

> （選用）一併安裝 **Simple Message Window** 與 **Stylish Action HUD** 以獲得完整體驗。

---

## 備註

- `ccf-ui.mjs` 與 `ccf-mobile.mjs` 各自複製一份 `shouldApply()`，刻意不跨檔 import 以避免 Foundry 中相鄰 esmodule 的解析問題；**修改其一時請同步另一份**。
- 模組的相容上限標示為 12，但僅在 v11 完成驗證。
