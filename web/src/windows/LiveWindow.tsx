// An app's own window component, live outside a window: a carousel's slide (`carousel/CarouselLayer.tsx`) and an open tile
// (`opentile/OpenTileLayer.tsx`). The same component a window holds (`appDef(app).Window`), so what it shows carries over
// between them, in the `ma-window` wrapper a window's insides expect around them: the shell's single keys stay out
// (`useKeyboard`), the Browser's address keys and menus find their window, an app's colors apply (`[data-app]`), and input
// counts for this desk (`deskInput`).
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { appDef } from '../apps/registry';
import type { AppId } from '../canvas/layout';

export function LiveWindow({ deskId, deskName, app, className, ref, children, ...rest }: {
  deskId: string;
  deskName: string;
  app: AppId;
  className: string;
  ref?: Ref<HTMLDivElement>;
  /** What goes before the app's body: a phone slide's own head. */
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'> & { inert?: boolean }) {
  const Body = appDef(app, deskId).Window;
  return (
    <div {...rest} ref={ref} className={`ma-window ${className}`} data-app={app} data-desk={deskId}>
      {children}
      <div className="window-body">
        <Body deskId={deskId} deskName={deskName} parked={false} app={app} />
      </div>
    </div>
  );
}
