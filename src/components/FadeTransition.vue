<template>
	<Transition
		enter-active-class="transition-opacity duration-150"
		enter-from-class="opacity-0"
		enter-to-class="opacity-100"
		leave-active-class="transition-opacity duration-150"
		leave-from-class="opacity-100"
		leave-to-class="opacity-0"
	>
		<slot />
	</Transition>
</template>
