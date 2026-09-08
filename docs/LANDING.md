# 官網版本開關

GitHub Pages 從 main 的 docs 發布。一般訪客預設看到原版 index.html；
新版獨立放在 landing-next.html，不載入到原版頁面。

- 正式首頁：https://sinotrade.github.io/shioaji-pro-app/
- 新版預覽：https://sinotrade.github.io/shioaji-pro-app/?landing=new
- 明確選擇原版：https://sinotrade.github.io/shioaji-pro-app/?landing=original

網址選擇不寫入瀏覽器儲存；關掉預覽、重新進入正式首頁仍使用全站預設。
這是展示版本開關，不是權限控管，新版內容可以公開存取。

## 之後正式切換

只有在使用者確認替換時，才將 landing-flag.js 的
LANDING_NEXT_ENABLED 從 false 改為 true，經 PR、CI 與 merge commit
合併後由 Pages 自動發布。不需要搬移新版檔案或發桌面版 tag。
需要回復原版時將同一旗標改回 false。

新版轉址保留其他 query 與 hash，預覽時也能直接連到功能區。
若 JavaScript 無法載入，首頁繼續顯示原版。
