import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import s from './AppBar.module.scss';

export function AppBar({
    title,
    back = -1,
    action,
}: {
    title?: string;
    back?: string | -1;
    action?: ReactNode;
}) {
    const navigate = useNavigate();
    return (
        <header className={s.bar}>
            <button
                type="button"
                className={s.icon}
                aria-label="Back"
                onClick={() => (back === -1 ? navigate(-1) : navigate(back))}
            >
                <Icon name="arrow-left" />
            </button>
            <h1 className={s.title}>{title}</h1>
            {action ?? <span className={s.icon} aria-hidden="true" />}
        </header>
    );
}

export function AppBarButton({
    label,
    onClick,
    children,
}: {
    label: string;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button type="button" className={s.icon} aria-label={label} onClick={onClick}>
            {children}
        </button>
    );
}
