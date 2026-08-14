import { createApp } from 'vue';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import './style.css';
import App from './App.vue';
import { router } from './router';
import { applyTheme, currentTheme } from './theme';

// 挂载前应用已保存主题，避免闪烁
applyTheme(currentTheme());

createApp(App).use(router).mount('#app');
