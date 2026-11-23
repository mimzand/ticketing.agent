import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';
import { applyTheme, browserStorage, readTheme } from './theme.js';

// theme-boot.js already set it before paint; this keeps the two in step.
applyTheme(document.documentElement, readTheme(browserStorage()));
createApp(App).mount('#app');
