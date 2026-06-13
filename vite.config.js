import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS必須: getUserMedia / Geolocation / DeviceOrientation はHTTPSでしか動かない。
// スマホ実機でAR(カメラ・方位センサー)を使うときは HTTPS で起動する:
//   npm run dev         （既定: HTTPS。自己署名証明書を一度許可する）
// デスクトップでのデモモード確認(カメラ不要)は HTTP でも可:
//   npm run dev:http
// host: true でLAN内のスマホから https://<PCのIP>:5173 にアクセスできる。
const useHttp = process.env.VITE_HTTP === '1';

export default defineConfig({
  plugins: useHttp ? [] : [basicSsl()],
  // locar も three を import するため、単一インスタンスに重複排除する
  resolve: { dedupe: ['three'] },
  server: {
    https: !useHttp,
    host: true,
    port: 5173,
  },
});
