package br.com.estoque.core.domain

/**
 * Janela de leitura da câmera: uma faixa horizontal centralizada, como nos coletores
 * de mercado.
 *
 * Na gôndola há vários códigos lado a lado. Se a leitura valesse o quadro inteiro, o
 * repositor apontaria para um produto e o aplicativo poderia aceitar o do vizinho —
 * e ele só descobriria depois de lançar a validade no produto errado. Com a janela,
 * o código precisa estar mirado.
 *
 * As medidas são frações do quadro, não pixels, para valerem em qualquer resolução —
 * dos 480x800 do coletor à câmera de um celular.
 */
object ScanWindow {
    const val WIDTH_FRACTION = 0.88f
    const val HEIGHT_FRACTION = 0.26f

    /**
     * Dimensões do quadro como o detector as enxerga. Em 90° ou 270° a imagem é
     * girada antes da análise, então largura e altura trocam.
     */
    fun frameSize(
        imageWidth: Int,
        imageHeight: Int,
        rotationDegrees: Int,
    ): Pair<Int, Int> =
        if (rotationDegrees == 90 || rotationDegrees == 270) {
            imageHeight to imageWidth
        } else {
            imageWidth to imageHeight
        }

    /**
     * Verdadeiro quando o centro do código lido cai dentro da janela.
     *
     * O critério é o centro, e não a caixa inteira: um código de barras é largo e
     * encostar as pontas fora da janela é normal quando ele está bem mirado.
     */
    fun accepts(
        centerX: Int,
        centerY: Int,
        frameWidth: Int,
        frameHeight: Int,
    ): Boolean {
        if (frameWidth <= 0 || frameHeight <= 0) return false
        val halfWidth = frameWidth * WIDTH_FRACTION / 2f
        val halfHeight = frameHeight * HEIGHT_FRACTION / 2f
        val middleX = frameWidth / 2f
        val middleY = frameHeight / 2f
        return centerX >= middleX - halfWidth &&
            centerX <= middleX + halfWidth &&
            centerY >= middleY - halfHeight &&
            centerY <= middleY + halfHeight
    }
}
