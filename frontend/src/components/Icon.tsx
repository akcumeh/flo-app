const modules = import.meta.glob<string>('../assets/icons/*.svg', {
    query: '?raw',
    import: 'default',
    eager: true,
});

const icons: Record<string, string> = {};
for (const [path, svg] of Object.entries(modules)) {
    const name = path.split('/').pop()?.replace('.svg', '');
    if (name) icons[name] = svg;
}

export type IconName =
    | 'arrow-left'
    | 'arrow-right'
    | 'arrow-up'
    | 'asterisk-action'
    | 'asterisk-avatar'
    | 'asterisk-card'
    | 'asterisk-large'
    | 'asterisk-tip'
    | 'asterisk-token'
    | 'bang'
    | 'bang-small'
    | 'battery'
    | 'bell'
    | 'bolt'
    | 'camera'
    | 'camera-solid'
    | 'caret-right'
    | 'chat'
    | 'check'
    | 'check-circle-fill'
    | 'check-small'
    | 'check-tiny'
    | 'chevron'
    | 'close'
    | 'copy'
    | 'doc'
    | 'dots'
    | 'file-line'
    | 'file-text'
    | 'fire'
    | 'help'
    | 'link'
    | 'lock'
    | 'lock-small'
    | 'logo-florence'
    | 'moon'
    | 'nav-ask'
    | 'nav-home'
    | 'nav-library'
    | 'nav-prep'
    | 'nav-progress'
    | 'new-chat'
    | 'plus'
    | 'school'
    | 'search'
    | 'search-small'
    | 'shield'
    | 'telegram'
    | 'thumb-down'
    | 'thumb-up'
    | 'upload'
    | 'warning-fill'
    | 'wifi-off'
    | 'x';

interface IconProps {
    name: IconName;
    className?: string;
}

export function Icon({ name, className }: IconProps) {
    return (
        <span
            aria-hidden="true"
            className={className}
            style={{ display: 'inline-flex', flexShrink: 0 }}
            dangerouslySetInnerHTML={{ __html: icons[name] ?? '' }}
        />
    );
}
