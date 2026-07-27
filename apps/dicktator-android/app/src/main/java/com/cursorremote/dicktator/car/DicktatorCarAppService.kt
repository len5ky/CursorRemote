package com.cursorremote.dicktator.car

import android.content.Intent
import androidx.car.app.CarAppService
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

/** Android Auto entry for DICKTATOR car Talk / Approve / Later / Hang Up. */
class DicktatorCarAppService : CarAppService() {
  override fun createHostValidator(): HostValidator = HostValidator.ALLOW_ALL_HOSTS_VALIDATOR

  override fun onCreateSession(): Session = DicktatorCarSession()
}

class DicktatorCarSession : Session() {
  override fun onCreateScreen(intent: Intent) = DicktatorCarScreen(carContext)
}
