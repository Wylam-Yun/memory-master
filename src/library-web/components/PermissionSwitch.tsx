/** 授权开关（role=switch）——供全局与项目设置使用。 */
export default function PermissionSwitch({
	checked,
	disabled,
	label,
	onChange,
}: {
	checked: boolean;
	disabled?: boolean;
	label: string;
	onChange: (next: boolean) => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			className={`relative h-7 w-12 shrink-0 rounded-circle transition-colors disabled:opacity-50 ${
				checked ? "bg-[#3B57D0]" : "bg-[#8A9099]/50"
			}`}
			onClick={() => onChange(!checked)}
		>
			<span
				className={`absolute top-0.5 left-0 h-6 w-6 rounded-circle bg-white shadow transition-transform ${
					checked ? "translate-x-[22px]" : "translate-x-0.5"
				}`}
			/>
		</button>
	);
}
