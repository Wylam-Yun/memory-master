import React from 'react';
import { BranchIndexingIndicator } from './BranchIndexingIndicator';
import ThemeToggle from './ThemeToggle';

interface NavigationProps {
    projectName: string;
    loadingMessage?: string | null;
}

const Navigation: React.FC<NavigationProps> = ({projectName, loadingMessage}) => {
    return (
        <nav className="relative px-4 sm:px-6 min-h-14 shrink-0 py-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 transition-colors duration-200">
            <div className="min-h-10 flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <h1 className="min-w-0 break-words text-sm sm:text-base font-semibold text-gray-900 dark:text-gray-100">{projectName || 'Loading...'}</h1>
                    <span className="text-sm text-gray-500 dark:text-gray-400">powered by</span>
                    <a
                        href="https://github.com/Wylam-Yun/memory-master"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-stone-600 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-300 hover:underline transition-colors duration-200"
                    >
                        Memaster
                    </a>
                </div>
                <div className="flex items-center gap-3">
                    <BranchIndexingIndicator message={loadingMessage} />
                    <ThemeToggle />
                </div>
            </div>
        </nav>
    );
};

export default Navigation;
