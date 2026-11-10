package expo.modules.mymodule

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.min

class GeoPhotoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GeoPhoto")

    AsyncFunction("renderAndTag") { sourceUri: String, destinationUri: String, details: Map<String, Any?> ->
      val source = File(Uri.parse(sourceUri).path ?: sourceUri.removePrefix("file://"))
      val destination = File(Uri.parse(destinationUri).path ?: destinationUri.removePrefix("file://"))
      require(source.exists()) { "Source photo is unavailable" }
      val decoderOptions = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(source.absolutePath, decoderOptions)
      require(decoderOptions.outWidth > 0 && decoderOptions.outHeight > 0) { "Unsupported or unreadable image" }
      val runtime = Runtime.getRuntime()
      val maxHeap = runtime.maxMemory()
      val freeHeap = (maxHeap - (runtime.totalMemory() - runtime.freeMemory())).coerceAtLeast(4_000_000L)
      // Keep the decoded image and the orientation copy small enough that the
      // renderer has room for the JPEG encoder and the rest of the app.
      // Bound peak bitmap memory more aggressively. Orientation may briefly
      // require a second bitmap, and the JPEG encoder needs additional heap.
      val targetPixels = ((min(maxHeap / 24L, freeHeap / 6L)) / 4L).coerceIn(80_000L, 1_000_000L)
      var sample = 1
      while (decoderOptions.outWidth.toLong() / sample * (decoderOptions.outHeight.toLong() / sample) > targetPixels && sample < (1 shl 20)) sample *= 2

      while (sample <= (1 shl 20)) {
        var bitmap: Bitmap? = null
        var oriented: Bitmap? = null
        try {
          val decoded = BitmapFactory.decodeFile(
            source.absolutePath,
            BitmapFactory.Options().apply {
              inSampleSize = sample
              inPreferredConfig = Bitmap.Config.ARGB_8888
              inDither = true
            }
          )
          if (decoded == null) {
            sample *= 2
            continue
          }
          bitmap = decoded
          val renderBitmap = orient(decoded, source)
          oriented = renderBitmap
          if (renderBitmap !== decoded) decoded.recycle()
          renderStamp(renderBitmap, details)
          destination.parentFile?.mkdirs()
          FileOutputStream(destination).use { stream ->
            check(renderBitmap.compress(Bitmap.CompressFormat.JPEG, 94, stream)) { "JPEG rendering failed" }
            stream.fd.sync()
          }
          try { copyExif(source, destination, details) } catch (_: Exception) { /* Keep the stamped JPEG and report unverified GPS below. */ }
          val found = try { ExifInterface(destination.absolutePath).latLong } catch (_: Throwable) { null }
          val lat = (details["latitude"] as Number).toDouble()
          val lon = (details["longitude"] as Number).toDouble()
          val verified = found != null && kotlin.math.abs(found[0] - lat) < 0.000001 && kotlin.math.abs(found[1] - lon) < 0.000001
          return@AsyncFunction mapOf("verified" to verified, "width" to renderBitmap.width, "height" to renderBitmap.height)
        } catch (_: OutOfMemoryError) {
          destination.delete()
          sample *= 2
          System.gc()
        } catch (e: Throwable) {
          destination.delete()
          throw e
        } finally {
          if (oriented != null && oriented !== bitmap) oriented.recycle()
          bitmap?.recycle()
        }
      }
      destination.delete()
      throw IllegalStateException("Insufficient memory to render this photo, even at a reduced size")
    }
  }

  private fun orient(bitmap: Bitmap, source: File): Bitmap {
    val orientation = try { ExifInterface(source.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } catch (_: Exception) { ExifInterface.ORIENTATION_NORMAL }
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> { matrix.setRotate(180f); matrix.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(-90f); matrix.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
    }
    return if (matrix.isIdentity) bitmap else Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
  }

  private fun renderStamp(bitmap: Bitmap, d: Map<String, Any?>) {
    val canvas = Canvas(bitmap)
    val scale = max(0.65f, min(bitmap.width, bitmap.height) / 420f)
    val pad = 12f * scale
    val address = if (d["addressEnabled"] == true) (d["address"] as? String).orEmpty().trim() else ""
    val addressLine = if (address.isNotEmpty()) "${d["addressLabel"] ?: "Approx. "}$address" else ""
    val timeLine = if (d["dateTimeEnabled"] != false) "${d["displayTime"] ?: ""}" else ""
    val coordinates = d["coordinatesEnabled"] != false
    if (addressLine.isEmpty() && timeLine.isEmpty() && !coordinates) return
    val textSize = 15f * scale
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.textSize = textSize; typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL) }
    val cardWidth = bitmap.width * 0.92f
    val contentWidth = cardWidth - 58f * scale
    fun wrap(text: String): List<String> {
      val result = mutableListOf<String>()
      var current = ""
      for (word in text.split(Regex("\\s+"))) {
        val candidate = if (current.isEmpty()) word else "$current $word"
        if (current.isNotEmpty() && paint.measureText(candidate) > contentWidth) { result.add(current); current = word } else current = candidate
      }
      if (current.isNotEmpty()) result.add(current)
      return result
    }
    val lines = mutableListOf<String>()
    if (timeLine.isNotEmpty()) lines.addAll(wrap(timeLine))
    if (addressLine.isNotEmpty()) lines.addAll(wrap(addressLine))
    val lineHeight = textSize * 1.35f
    val coordHeight = if (coordinates) 17f * scale else 0f
    val cardHeight = max(48f * scale, lines.size * lineHeight + coordHeight + 2 * pad)
    val placement = d["placement"] as? String ?: "bottom-left"
    val left = if (placement.endsWith("right")) bitmap.width - pad - cardWidth else pad
    val top = if (placement.startsWith("top")) pad else bitmap.height - pad - cardHeight
    val style = d["style"] as? String ?: "dark"
    val bg = when (style) { "light" -> Color.argb(168, 255, 255, 255); "solid" -> Color.rgb(23, 107, 74); else -> Color.argb(150, 10, 12, 12) }
    val foreground = if (style == "light") Color.rgb(23, 36, 31) else Color.WHITE
    val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = bg }
    canvas.drawRoundRect(RectF(left, top, left + cardWidth, top + cardHeight), 15f * scale, 15f * scale, bgPaint)
    val cx = left + 22f * scale; val cy = top + cardHeight / 2
    val pinPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(121, 198, 154) }
    val pinTail = Path().apply {
      moveTo(cx - 5f * scale, cy + 1f * scale)
      lineTo(cx, cy + 12f * scale)
      lineTo(cx + 5f * scale, cy + 1f * scale)
      close()
    }
    canvas.drawPath(pinTail, pinPaint)
    canvas.drawCircle(cx, cy - 3f * scale, 7f * scale, pinPaint)
    val pinHole = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = bg }
    canvas.drawCircle(cx, cy - 3f * scale, 2.5f * scale, pinHole)
    paint.color = foreground
    val textLeft = left + 42f * scale
    var baseline = top + pad + textSize
    lines.forEach { line -> canvas.drawText(line, textLeft, baseline, paint); baseline += lineHeight }
    if (coordinates) {
      val coordPaint = Paint(paint).apply { setTextSize(12f * scale) }
      val lat = "Lat: ${(d["latitude"] as Number).toDouble().formatCoord()}"
      val lon = "Long: ${(d["longitude"] as Number).toDouble().formatCoord()}"
      val right = left + cardWidth - pad - coordPaint.measureText(lon)
      val rowBaseline = if (lines.isEmpty()) top + pad + coordPaint.textSize else baseline + 2f * scale
      canvas.drawText(lat, textLeft, rowBaseline, coordPaint)
      canvas.drawText(lon, max(textLeft + coordPaint.measureText(lat) + 8f * scale, right), rowBaseline, coordPaint)
    }
  }

  private fun copyExif(source: File, destination: File, d: Map<String, Any?>) {
    val input = ExifInterface(source.absolutePath)
    val output = ExifInterface(destination.absolutePath)
    val keep = listOf(ExifInterface.TAG_DATETIME, ExifInterface.TAG_DATETIME_ORIGINAL, ExifInterface.TAG_DATETIME_DIGITIZED, ExifInterface.TAG_MAKE, ExifInterface.TAG_MODEL, ExifInterface.TAG_LENS_MAKE, ExifInterface.TAG_LENS_MODEL, ExifInterface.TAG_FOCAL_LENGTH, ExifInterface.TAG_F_NUMBER, ExifInterface.TAG_EXPOSURE_TIME, ExifInterface.TAG_ISO_SPEED_RATINGS, ExifInterface.TAG_WHITE_BALANCE, ExifInterface.TAG_FLASH, ExifInterface.TAG_SOFTWARE)
    keep.forEach { tag -> input.getAttribute(tag)?.let { output.setAttribute(tag, it) } }
    (d["captureTimeExif"] as? String)?.takeIf { it.isNotBlank() }?.let { capturedAt ->
      output.setAttribute(ExifInterface.TAG_DATETIME, capturedAt)
      output.setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL, capturedAt)
      output.setAttribute(ExifInterface.TAG_DATETIME_DIGITIZED, capturedAt)
    }
    output.setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL.toString())
    output.setLatLong((d["latitude"] as Number).toDouble(), (d["longitude"] as Number).toDouble())
    output.saveAttributes()
  }

  private fun Double.formatCoord() = String.format(java.util.Locale.US, "%.6f", this)
}
