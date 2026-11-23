import './ui/mobile.css';
import { mountMobile } from './ui/mobile';
import { showIntro } from './ui/intro';

// The intro goes up first, so the page is never seen before it; the page gets ready underneath.
void showIntro();
const root = document.getElementById('app');
if (root) mountMobile(root);
