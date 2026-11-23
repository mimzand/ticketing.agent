import { type RendererApi } from '@ticket/shared';

declare module '*.vue' {
  import { type DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare global {
  interface Window {
    /** The preload bridge: the renderer's only way to reach main. */
    readonly api: RendererApi;
  }
}
