import './ui/mobile.css';
import { mountMobile } from './ui/mobile';
import { showIntro } from './ui/intro';

const root = document.getElementById('app');
if (root) mountMobile(root);
// The intro plays over the page while it gets ready underneath.
void showIntro();
