<script setup lang="ts">
import router from '../router';
function beginSetup(): void {
  router.replace('/board-loader')
}
</script>

<template>
  <main class="text-center">
    <div class="welcome-logo background-card">
      <h1>Welcome to</h1>
      <img src="../../shared/assets/rrlogofinal.png" alt="RoboRally logo from Renegade Studios"></img>
      <button class="big-button" @click="beginSetup()">Begin Setup</button>
    </div>
  </main>
</template>

<style lang="css" scoped>
.welcome-logo {
  padding: .5em .25em;
  margin: 0em .5em;
}

.cover-image {
  margin: 0px .5em;
  width: calc(100% - 1em);
  max-width: 400px;
}
</style>