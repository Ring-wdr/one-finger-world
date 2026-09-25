import { effect } from '@preact/signals';
import { Sfx } from '../audio/Sfx';
import { sfxGain } from '../meta/settings';
import { settings } from './store';

/** One sound engine for menus and the game, so UI clicks work before the game is loaded. */
export const sfx = new Sfx();

effect(() => sfx.setVolume(sfxGain(settings.value)));
