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
    | 'asterisk-tip'
    | 'asterisk-token'
    | 'bang'
    | 'bang-small'
    | 'battery'
    | 'bell'
    | 'bolt'
    | 'camera'
    | 'chat'
    | 'check'
    | 'check-small'
    | 'chevron'
    | 'close'
    | 'copy'
    | 'doc'
    | 'fire'
    | 'help'
    | 'link'
    | 'lock'
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
    | 'shield'
    | 'telegram'
    | 'thumb-down'
    | 'thumb-up'
    | 'upload'
    | 'wifi-off';

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
