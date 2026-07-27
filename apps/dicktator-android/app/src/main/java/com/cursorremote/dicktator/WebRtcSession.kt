package com.cursorremote.dicktator

import android.content.Context
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.JavaAudioDeviceModule
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Owns the phone-side microphone and playout tracks for one OpenAI call. */
class WebRtcSession(context: Context) {
  private val appContext = context.applicationContext
  private var audioDeviceModule: JavaAudioDeviceModule? = null
  private var factory: PeerConnectionFactory? = null
  private var peerConnection: PeerConnection? = null
  private var audioSource: AudioSource? = null
  private var audioTrack: AudioTrack? = null

  fun connect(ephemeralKey: String): RealtimeCall {
    PeerConnectionFactory.initialize(
      PeerConnectionFactory.InitializationOptions.builder(appContext).createInitializationOptions(),
    )
    audioDeviceModule = JavaAudioDeviceModule.builder(appContext).createAudioDeviceModule()
    factory = PeerConnectionFactory.builder().setAudioDeviceModule(audioDeviceModule).createPeerConnectionFactory()
    peerConnection = requireNotNull(factory).createPeerConnection(
      PeerConnection.RTCConfiguration(emptyList()),
      object : PeerConnection.Observer {
        override fun onSignalingChange(newState: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) = Unit
        override fun onIceCandidate(candidate: IceCandidate) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onDataChannel(dataChannel: DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit
      },
    ) ?: throw IllegalStateException("Unable to create WebRTC peer connection")
    audioSource = requireNotNull(factory).createAudioSource(MediaConstraints())
    audioTrack = requireNotNull(factory).createAudioTrack("dicktator-mic", requireNotNull(audioSource))
    requireNotNull(peerConnection).addTrack(requireNotNull(audioTrack), listOf("dicktator"))

    val offer = awaitOffer(requireNotNull(peerConnection))
    awaitSetDescription(requireNotNull(peerConnection), offer, local = true)
    val call = RealtimeCallClient().createCall(ephemeralKey, offer.description)
    awaitSetDescription(requireNotNull(peerConnection), SessionDescription(SessionDescription.Type.ANSWER, call.answerSdp), local = false)
    return call
  }

  fun stop() {
    peerConnection?.close()
    peerConnection = null
    audioTrack?.dispose()
    audioTrack = null
    audioSource?.dispose()
    audioSource = null
    factory?.dispose()
    factory = null
    audioDeviceModule?.release()
    audioDeviceModule = null
  }

  private fun awaitOffer(connection: PeerConnection): SessionDescription {
    var offer: SessionDescription? = null
    awaitSdp("create offer") { observer -> connection.createOffer(observer, MediaConstraints()) } { offer = it }
    return requireNotNull(offer)
  }

  private fun awaitSetDescription(connection: PeerConnection, description: SessionDescription, local: Boolean) {
    awaitSdp(if (local) "set local description" else "set remote description") { observer ->
      if (local) connection.setLocalDescription(observer, description) else connection.setRemoteDescription(observer, description)
    }
  }

  private fun awaitSdp(action: String, block: (SdpObserver) -> Unit, onCreateSuccess: (SessionDescription) -> Unit = {}) {
    val done = CountDownLatch(1)
    var error: String? = null
    block(object : SdpObserver {
      override fun onCreateSuccess(description: SessionDescription) {
        onCreateSuccess(description)
        done.countDown()
      }

      override fun onSetSuccess() = done.countDown()
      override fun onCreateFailure(message: String) { error = message; done.countDown() }
      override fun onSetFailure(message: String) { error = message; done.countDown() }
    })
    if (!done.await(SDP_TIMEOUT_SECONDS, TimeUnit.SECONDS)) throw IllegalStateException("WebRTC $action timed out")
    error?.let { throw IllegalStateException("WebRTC $action failed: $it") }
  }

  private companion object {
    const val SDP_TIMEOUT_SECONDS = 15L
  }
}
