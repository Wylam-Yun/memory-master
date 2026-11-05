import { type KeyboardEvent, useRef } from "react";

/**
 * 拼音等输入法合成期内按 Enter/Esc 也会触发 keydown，不能当作提交或关闭信号。
 * compositionend 后标志延迟一拍再清——部分 IME 在结束后才补发确认候选词的 Enter。
 */
export function useImeGuard() {
	const composing = useRef(false);
	return {
		/** 挂到文本输入框或其祖先表单（composition 事件冒泡）。 */
		compositionProps: {
			onCompositionStart: () => {
				composing.current = true;
			},
			onCompositionEnd: () => {
				window.setTimeout(() => {
					composing.current = false;
				});
			},
		},
		/** 合成中或刚结束的按键——调用方应吞掉 Enter/Esc 等动作。 */
		inComposition: (e: KeyboardEvent) => composing.current || e.nativeEvent.isComposing,
	};
}
